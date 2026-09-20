// ─── R2 Music Library Router ──────────────────────────────────────────────────
// Mounts at /library in index.js
// User-owned Cloud Library backed by Cloudflare R2 + PostgreSQL.
// All operations are strictly scoped to the authenticated user (tracks.user_id = req.userId).

const express = require('express');
const multer  = require('multer');
const path    = require('path');

const {
  uploadToR2,
  getStreamUrl,
  getTextObject,
  deleteFromR2,
  PER_USER_STORAGE_LIMIT_BYTES,
  getUserAudioKey,
  getUserCoverKey,
  getUserLyricsKey,
} = require('./r2');

const {
  insertTrack,
  getAllTracks,
  getTrack,
  deleteTrack,
  updateTrackLyricsKey,
  getUserStorageUsage,
  withUserLock,
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
// Returns ONLY tracks owned by the authenticated user
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const tracks = await getAllTracks(req.userId);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json(tracks);
  } catch (err) {
    logger.error('GET /library failed', { error: err.message, userId: req.userId });
    res.status(500).json({ error: 'Failed to fetch library tracks' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /library/storage
// Returns per-user Cloud Library storage usage stats
// ─────────────────────────────────────────────────────────────────────────────
router.get('/storage', async (req, res) => {
  try {
    const limit = PER_USER_STORAGE_LIMIT_BYTES;
    if (!req.userId || req.user?.is_guest) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      return res.json({
        used: 0,
        limit,
        usedGB: '0.00',
        limitGB: (limit / (1024 ** 3)).toFixed(1),
        percentUsed: '0.0',
        isFull: false,
        isGuest: true,
      });
    }

    const used = await getUserStorageUsage(req.userId);
    const percentUsed = Math.min(100, (used / limit) * 100).toFixed(1);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({
      used,
      limit,
      usedGB: (used / (1024 ** 3)).toFixed(2),
      limitGB: (limit / (1024 ** 3)).toFixed(1),
      percentUsed,
      isFull: used >= limit,
      isGuest: false,
    });
  } catch (err) {
    logger.error('GET /library/storage failed', { error: err.message, userId: req.userId });
    res.status(500).json({ error: 'Failed to fetch storage stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /library/upload
// Requires permanent user (is_guest = false).
// Sets tracks.user_id = req.userId (server-authoritative).
// Concurrency-safe per-user quota checking via PostgreSQL advisory lock.
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
    if (!req.userId || !req.user || req.user.is_guest) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Permanent account required to upload to Cloud Library',
        code: 'AUTH_REQUIRED',
      });
    }

    const audio  = req.files?.audio?.[0];
    const cover  = req.files?.cover?.[0];
    const lyrics = req.files?.lyrics?.[0];

    if (!audio) {
      return res.status(400).json({ error: 'audio field is required' });
    }

    // Validate lyrics extension if provided
    if (lyrics) {
      const lrcExt = path.extname(lyrics.originalname || '').toLowerCase();
      if (lrcExt && lrcExt !== '.lrc') {
        return res.status(400).json({ error: 'Only .lrc files are supported for lyrics' });
      }
    }

    const { v4: uuidv4 } = await import('uuid');
    const id     = uuidv4();
    const format = getExt(audio);

    const title    = (req.body?.title  || '').trim() || audio.originalname?.replace(/\.[^.]+$/, '') || 'Untitled';
    const artist   = (req.body?.artist || '').trim() || null;
    const duration = parseFloat(req.body?.duration) || null;

    const audioKey  = getUserAudioKey(req.userId, id, format);
    let coverKey    = null;
    let lyricsKey   = null;

    if (cover) {
      const coverExt = getExt(cover);
      coverKey = getUserCoverKey(req.userId, id, coverExt);
    }
    if (lyrics) {
      lyricsKey = getUserLyricsKey(req.userId, id);
    }

    // ── Concurrency-safe quota check + atomic track creation ─────────────────
    let track;
    try {
      track = await withUserLock(req.userId, async (client) => {
        const currentUsage = await getUserStorageUsage(req.userId, client);
        if (currentUsage + audio.size > PER_USER_STORAGE_LIMIT_BYTES) {
          const err = new Error('STORAGE_FULL');
          err.code = 'STORAGE_FULL';
          err.usedBytes = currentUsage;
          throw err;
        }

        // Upload audio to R2
        await uploadToR2(audioKey, audio.buffer, audio.mimetype || 'audio/mpeg');

        // Upload cover if present (non-fatal)
        if (coverKey && cover) {
          try {
            await uploadToR2(coverKey, cover.buffer, cover.mimetype || 'image/jpeg');
          } catch (covErr) {
            logger.warn('R2 cover upload failed (non-fatal)', { error: covErr.message });
            coverKey = null;
          }
        }

        // Upload lyrics if present (non-fatal)
        if (lyricsKey && lyrics) {
          try {
            await uploadToR2(lyricsKey, lyrics.buffer, 'text/plain');
          } catch (lyrErr) {
            logger.warn('R2 lyrics upload failed (non-fatal)', { error: lyrErr.message });
            lyricsKey = null;
          }
        }

        // Persist metadata to PostgreSQL under the user's ID
        return await insertTrack({
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
          provider_track_id: null,
          user_id: req.userId,
        }, client);
      });
    } catch (err) {
      if (err.code === 'STORAGE_FULL' || err.message === 'STORAGE_FULL') {
        return res.status(507).json({
          error: 'Storage quota exceeded',
          message: 'Your Cloud Library has reached its 2GB limit. Delete some tracks to free space.',
        });
      }
      logger.error('Track upload failed', { error: err.message, userId: req.userId });
      // Best-effort cleanup of any uploaded R2 objects on failure
      deleteFromR2(audioKey).catch(() => {});
      if (coverKey)  deleteFromR2(coverKey).catch(() => {});
      if (lyricsKey) deleteFromR2(lyricsKey).catch(() => {});
      return res.status(500).json({ error: 'Failed to upload track' });
    }

    logger.info('Track uploaded to Cloud Library', { id, title, format, size: audio.size, userId: req.userId });
    res.json({ success: true, track });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /library/:id
// Returns single track metadata with strict ownership check
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const track = await getTrack(req.params.id, req.userId);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    res.json({ track });
  } catch (err) {
    logger.error('GET /library/:id failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to fetch track' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /library/:id/stream
// Returns presigned R2 URL ONLY AFTER verifying track ownership
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/stream', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const track = await getTrack(req.params.id, req.userId);
    if (!track || !track.audio_key) {
      return res.status(404).json({ error: 'Track not found' });
    }
    const url = await getStreamUrl(track.audio_key);
    res.json({ url });
  } catch (err) {
    logger.error('GET /library/:id/stream failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to generate stream URL' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /library/:id/lyrics
// Returns plain text lyrics ONLY AFTER verifying track ownership
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/lyrics', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const track = await getTrack(req.params.id, req.userId);
    if (!track || !track.lyrics_key) {
      return res.status(404).json({ error: 'Lyrics not found' });
    }

    const content = await getTextObject(track.lyrics_key);
    if (content === null || content === undefined) {
      return res.status(404).json({ error: 'Lyrics object not found' });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(content);
  } catch (err) {
    logger.error('GET /library/:id/lyrics failed', { error: err.message, id: req.params.id });
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Lyrics file not found in storage' });
    }
    res.status(500).json({ error: 'Failed to fetch lyrics' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /library/:id/lyrics
// Associates or replaces .lrc lyrics ONLY AFTER verifying track ownership
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/lyrics',
  upload.single('lyrics'),
  async (req, res) => {
    try {
      if (!req.userId || !req.user || req.user.is_guest) {
        return res.status(403).json({ error: 'Forbidden', message: 'Permanent account required' });
      }

      const track = await getTrack(req.params.id, req.userId);
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

      const lyricsKey = getUserLyricsKey(req.userId, track.id);
      await uploadToR2(lyricsKey, file.buffer, 'text/plain');
      await updateTrackLyricsKey(track.id, lyricsKey, req.userId);

      logger.info('Lyrics updated for track', { id: track.id, lyricsKey, userId: req.userId });
      res.json({ success: true, lyrics_key: lyricsKey });
    } catch (err) {
      logger.error('POST /library/:id/lyrics failed', { error: err.message, id: req.params.id });
      res.status(500).json({ error: 'Failed to save lyrics' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /library/:id/cover
// Redirects to signed URL for cover ONLY AFTER verifying track ownership
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/cover', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const track = await getTrack(req.params.id, req.userId);
    if (!track || !track.cover_key) {
      return res.status(404).json({ error: 'Cover not found' });
    }
    const url = await getStreamUrl(track.cover_key);
    res.redirect(url);
  } catch (err) {
    logger.error('GET /library/:id/cover failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to fetch cover URL' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /library/:id
// Deletes track with ownership verification.
// Safe partial failure strategy:
// 1. Ownership is verified first.
// 2. PostgreSQL record is deleted with ownership check (WHERE id = $1 AND user_id = $2).
//    If DB delete fails, R2 objects remain intact for safe retry.
// 3. R2 objects are cleaned up best-effort after DB deletion.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

    // 1. Verify ownership first
    const track = await getTrack(req.params.id, req.userId);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // 2. Delete from PostgreSQL with ownership enforcement
    const deletedRow = await deleteTrack(track.id, req.userId);
    if (!deletedRow) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // 3. Delete R2 objects (best-effort)
    const deletions = [];
    if (track.audio_key)  deletions.push(deleteFromR2(track.audio_key));
    if (track.cover_key)  deletions.push(deleteFromR2(track.cover_key));
    if (track.lyrics_key) deletions.push(deleteFromR2(track.lyrics_key));

    const results = await Promise.allSettled(deletions);
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      logger.warn('Some R2 objects failed to delete during track deletion', {
        trackId: track.id,
        userId: req.userId,
        failedCount: failures.length,
      });
    }

    logger.info('Track deleted from Cloud Library', { id: track.id, title: track.title, userId: req.userId });
    res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /library/:id failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to delete track' });
  }
});

module.exports = router;
