// ─── R2 Music Library Router ──────────────────────────────────────────────────
// Mounts at /library in index.js
// All new persistent-library endpoints backed by Cloudflare R2 + PostgreSQL.

const express = require('express');
const multer  = require('multer');
const path    = require('path');

const {
  uploadToR2,
  getStreamUrl,
  getObject,
  getTextObject,
  deleteFromR2,
  getTotalStorageUsed,
  checkStorageLimit,
} = require('./r2');

const {
  insertTrack,
  getAllTracks,
  getTrack,
  deleteTrack,
  updateTrackLyricsKey,
} = require('./db');

const logger = require('./logger');

const router = express.Router();

// Multer: memory storage, 2 GB file size cap
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: derive file extension from mime type or original filename
// ─────────────────────────────────────────────────────────────────────────────
function getExtFromMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('flac'))       return 'flac';
  if (m.includes('wav'))        return 'wav';
  if (m.includes('ogg'))        return 'ogg';
  if (m.includes('aac'))        return 'aac';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  return 'mp3';
}

function getExt(file) {
  if (file.originalname && file.originalname.includes('.')) {
    return path.extname(file.originalname).replace('.', '').toLowerCase() || getExtFromMime(file.mimetype);
  }
  return getExtFromMime(file.mimetype);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /library
// Returns all tracks from PostgreSQL as a JSON array
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (_req, res) => {
  try {
    const tracks = await getAllTracks();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json(tracks);
  } catch (err) {
    logger.error('GET /library failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch library tracks' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /library/storage
// Returns R2 bucket storage usage stats
// ─────────────────────────────────────────────────────────────────────────────
const LIMIT_BYTES = 9.5 * 1024 * 1024 * 1024;

router.get('/storage', async (_req, res) => {
  try {
    const used = await getTotalStorageUsed();
    const percentUsed = ((used / LIMIT_BYTES) * 100).toFixed(1);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({
      used,
      limit: Math.round(LIMIT_BYTES),
      usedGB: (used / (1024 ** 3)).toFixed(2),
      limitGB: '9.5',
      percentUsed,
      isFull: used >= LIMIT_BYTES,
    });
  } catch (err) {
    logger.error('GET /library/storage failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch storage stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /library/upload
// Accepts: audio (required), cover (optional), lyrics (optional)
// Body fields: title, artist, duration
// Inline 10-minute timeout to survive Render's free-tier limit for large files.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/upload',
  (req, res, next) => {
    req.setTimeout(600_000); // 10 minutes
    res.setTimeout(600_000);
    next();
  },
  upload.fields([
    { name: 'audio',  maxCount: 1 },
    { name: 'cover',  maxCount: 1 },
    { name: 'lyrics', maxCount: 1 },
  ]),
  async (req, res) => {
    console.log('[library/upload] files received:', req.files ? Object.keys(req.files) : 'none', 'body:', req.body);
    const audio  = req.files?.audio?.[0];
    const cover  = req.files?.cover?.[0];
    const lyrics = req.files?.lyrics?.[0];

    if (!audio) {
      return res.status(400).json({ error: 'audio field is required' });
    }

    // ── Storage guard — check BEFORE any upload ──────────────────────────
    try {
      await checkStorageLimit(audio.size);
    } catch (err) {
      if (err.code === 'STORAGE_FULL' || err.message === 'STORAGE_FULL') {
        return res.status(507).json({
          error: 'Storage full',
          message: 'Library has reached its 9.5GB limit. Delete some tracks to free space.',
        });
      }
      logger.error('Storage check failed', { error: err.message });
      return res.status(500).json({ error: 'Failed to check storage capacity' });
    }

    const { v4: uuidv4 } = await import('uuid');
    const id     = uuidv4();
    const format = getExt(audio);

    // ── Upload audio to R2 ───────────────────────────────────────────────
    const audioKey = `audio/${id}.${format}`;
    try {
      await uploadToR2(audioKey, audio.buffer, audio.mimetype || 'audio/mpeg');
    } catch (err) {
      logger.error('R2 audio upload failed', { error: err.message });
      return res.status(500).json({ error: 'Failed to upload audio to R2' });
    }

    // ── Upload cover image (optional) ───────────────────────────────────
    let coverKey = null;
    if (cover) {
      const coverExt = getExt(cover);
      coverKey = `covers/${id}.${coverExt}`;
      try {
        await uploadToR2(coverKey, cover.buffer, cover.mimetype || 'image/jpeg');
      } catch (err) {
        logger.warn('R2 cover upload failed (non-fatal)', { error: err.message });
        coverKey = null;
      }
    }

    // ── Upload lyrics .lrc (optional) ───────────────────────────────────
    let lyricsKey = null;
    if (lyrics) {
      const lrcExt = path.extname(lyrics.originalname || '').toLowerCase();
      if (lrcExt && lrcExt !== '.lrc') {
        deleteFromR2(audioKey).catch(() => {});
        if (coverKey) deleteFromR2(coverKey).catch(() => {});
        return res.status(400).json({ error: 'Only .lrc files are supported for lyrics' });
      }

      lyricsKey = `lyrics/${id}.lrc`;
      try {
        await uploadToR2(lyricsKey, lyrics.buffer, 'text/plain');
      } catch (err) {
        logger.error('R2 lyrics upload failed', { error: err.message });
        deleteFromR2(audioKey).catch(() => {});
        if (coverKey) deleteFromR2(coverKey).catch(() => {});
        return res.status(500).json({ error: 'Failed to upload lyrics to R2' });
      }
    }

    // ── Persist metadata to PostgreSQL ──────────────────────────────────
    const title    = (req.body?.title  || '').trim() || audio.originalname?.replace(/\.[^.]+$/, '') || 'Untitled';
    const artist   = (req.body?.artist || '').trim() || null;
    const duration = parseFloat(req.body?.duration) || null;

    let track;
    try {
      track = await insertTrack({
        id,
        title,
        artist,
        duration,
        size: audio.size,
        format,
        audio_key: audioKey,
        cover_key: coverKey,
        lyrics_key: lyricsKey,
        provider: 'local',
        provider_track_id: null
      });
    } catch (err) {
      logger.error('DB insert failed', { error: err.message });
      deleteFromR2(audioKey).catch(() => {});
      if (coverKey)  deleteFromR2(coverKey).catch(() => {});
      if (lyricsKey) deleteFromR2(lyricsKey).catch(() => {});
      return res.status(500).json({ error: 'Failed to save track metadata' });
    }

    logger.info('Track uploaded to R2 library', { id, title, format, size: audio.size });
    res.json({ success: true, track });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /library/:id/stream
// Returns a signed URL for the audio file (valid 1 hour)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/stream', async (req, res) => {
  try {
    const track = await getTrack(req.params.id);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    const url = await getStreamUrl(track.audio_key);
    res.json({ url });
  } catch (err) {
    logger.error('GET /library/:id/stream failed', { error: err.message });
    res.status(500).json({ error: 'Failed to generate stream URL' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /library/:id/lyrics
// Returns the lyrics content directly as plain text (UTF-8)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/lyrics', async (req, res) => {
  try {
    const track = await getTrack(req.params.id);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    if (!track.lyrics_key) return res.status(404).json({ error: 'No lyrics for this track' });

    const content = await getTextObject(track.lyrics_key);
    if (content === null || content === undefined) {
      return res.status(404).json({ error: 'Lyrics object not found' });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(content);
  } catch (err) {
    logger.error('GET /library/:id/lyrics failed', { error: err.message });
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Lyrics file not found in storage' });
    }
    res.status(500).json({ error: 'Failed to fetch lyrics' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /library/:id/lyrics
// Associates or replaces .lrc lyrics on an existing R2 track
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/lyrics',
  upload.single('lyrics'),
  async (req, res) => {
    try {
      const track = await getTrack(req.params.id);
      if (!track) {
        return res.status(404).json({ error: 'Track not found' });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'lyrics file is required' });
      }

      const ext = path.extname(file.originalname || '').toLowerCase();
      if (ext !== '.lrc') {
        return res.status(400).json({ error: 'Only .lrc files are supported' });
      }

      const lyricsKey = `lyrics/${track.id}.lrc`;

      try {
        await uploadToR2(lyricsKey, file.buffer, 'text/plain');
      } catch (err) {
        logger.error('R2 lyrics upload failed', { error: err.message });
        return res.status(500).json({ error: 'Failed to upload lyrics to R2' });
      }

      await updateTrackLyricsKey(track.id, lyricsKey);

      logger.info('Lyrics updated for R2 track', { id: track.id, lyricsKey });
      res.json({ success: true, lyrics_key: lyricsKey });
    } catch (err) {
      logger.error('POST /library/:id/lyrics failed', { error: err.message });
      res.status(500).json({ error: 'Failed to save lyrics' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /library/:id/cover
// Redirects to signed URL for the cover image
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/cover', async (req, res) => {
  try {
    const track = await getTrack(req.params.id);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    if (!track.cover_key) return res.status(404).json({ error: 'No cover for this track' });
    const url = await getStreamUrl(track.cover_key);
    res.redirect(url);
  } catch (err) {
    logger.error('GET /library/:id/cover failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch cover URL' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /library/:id
// Deletes audio + cover + lyrics from R2, then removes DB record
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const track = await getTrack(req.params.id);
    if (!track) return res.status(404).json({ error: 'Track not found' });

    // Delete R2 objects (all best-effort in parallel)
    const deletions = [deleteFromR2(track.audio_key)];
    if (track.cover_key)  deletions.push(deleteFromR2(track.cover_key));
    if (track.lyrics_key) deletions.push(deleteFromR2(track.lyrics_key));

    await Promise.allSettled(deletions); // never throw on partial failures

    // Remove from PostgreSQL
    await deleteTrack(track.id);

    logger.info('Track deleted from R2 library', { id: track.id, title: track.title });
    res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /library/:id failed', { error: err.message });
    res.status(500).json({ error: 'Failed to delete track' });
  }
});

module.exports = router;
