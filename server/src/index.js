// ─── NoirSync Server Entry Point ──────────────────────────────────────────
// Express + Socket.io backend with:
//   • Helmet security headers
//   • CORS configuration
//   • gzip compression
//   • Rate limiting (per-route)
//   • Input validation middleware
//   • Winston structured logging
//   • Graceful shutdown handler
//   • /health check endpoint
//   • /admin/stats endpoint (dev only)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const compression = require('compression');
const multer     = require('multer');

const { RoomManager }                                  = require('./rooms');
const { handleNtp }                                    = require('./ntp');
const logger                                           = require('./logger');
const { apiLimiter, uploadLimiter, ntpLimiter }        = require('./middleware/rateLimiter');
const { validateRoomId, validateChunkIndex, validateChunkUpload, validateChunkFile } =
  require('./middleware/validate');

// ─── App setup ────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

// Trust first proxy (Render, Cloudflare, Heroku) for accurate protocol and client IP
app.set('trust proxy', 1);

const corsOrigin = process.env.CORS_ORIGIN || '*';
const maxChunkMB = parseInt(process.env.MAX_CHUNK_SIZE_MB || '10', 10);

// ─── Security & performance middleware ────────────────────────────────────

app.use(helmet({
  // Allow cross-origin requests for media (needed for MSE streaming)
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'connect-src': ["'self'", "ws:", "wss:"],
      'media-src': ["'self'", "blob:", "data:", "https://*"],
      'img-src': ["'self'", "data:", "blob:", "https://*"],
    },
  },
}));

const { sessionMiddleware } = require('./auth/session');
const oauthRoutes = require('./auth/oauthRoutes');

app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true, // Need this for cookies
}));

app.use(compression());
app.use(express.json({ limit: '1mb' }));

const authRoutes = require('./auth/authRoutes');
const playlistRoutes = require('./playlists/routes');

// Mount Auth routes with session middleware
app.use('/api/auth', sessionMiddleware, authRoutes);
// Mount OAuth routes with session middleware
app.use('/api/music', sessionMiddleware, oauthRoutes);
// Mount Playlist routes with session middleware
app.use('/api/playlists', sessionMiddleware, playlistRoutes);

// ─── Socket.io ────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  maxHttpBufferSize: maxChunkMB * 1024 * 1024,
  pingTimeout: 20_000,
  pingInterval: 25_000,
});

const roomManager = new RoomManager();

// ─── HTTP request logger (lightweight, not morgan) ────────────────────────

app.use((req, _res, next) => {
  logger.http(`${req.method} ${req.url}`, { ip: req.ip });
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    rooms: roomManager.rooms.size,
  });
});

// ─── Admin stats (disabled in production) ─────────────────────────────────

if (process.env.NODE_ENV !== 'production') {
  app.get('/admin/stats', (_req, res) => {
    res.json({
      rooms: roomManager.getRoomStats(),
      memory: process.memoryUsage(),
      uptime: process.uptime(),
    });
  });
}

// ─── NTP Clock Sync ───────────────────────────────────────────────────────

app.post('/api/ntp', ntpLimiter, express.json(), handleNtp);

// ─── Chunk Upload ─────────────────────────────────────────────────────────

const libraryManager  = require('./libraryManager');
const libraryRoutes   = require('./libraryRoutes');
const db              = require('./db');
const fs              = require('fs');

// ─── R2 Persistent Library Routes ────────────────────────────────────────────
const musicRoutes     = require('./music/routes');

// Mounted at /library (separate from legacy /api/library Telegram routes)
// Provides clean Postgres DB queries for client components
app.use('/library', sessionMiddleware, libraryRoutes);
app.use('/api/music', musicRoutes);

// ─── Chunk Upload ─────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxChunkMB * 1024 * 1024 },
});

app.post(
  '/api/rooms/:roomId/chunks',
  apiLimiter,
  uploadLimiter,
  validateRoomId,
  upload.single('chunk'),
  validateChunkFile,
  validateChunkUpload,
  (req, res) => {
    const { roomId } = req.params;
    const { chunkIndex, totalChunks, mimeType, songName } = req.body;
    const room = roomManager.getRoom(roomId);

    if (!room) return res.status(404).json({ error: 'Room not found' });

    const idx = parseInt(chunkIndex, 10);
    room.addChunk(idx, req.file.buffer, mimeType);

    if (songName && !room.state.songName) room.setState({ songName });
    if (totalChunks)  room.setState({ totalChunks: parseInt(totalChunks, 10) });

    // Notify all viewers that a new chunk is ready to download
    io.to(roomId).emit('chunk:available', {
      chunkIndex: idx,
      totalChunks: parseInt(totalChunks, 10),
    });

    res.json({ ok: true, chunkIndex: idx });
  }
);

// ─── Persistent Music Library API ──────────────────────────────────────────

// Temporary folder for library uploads
const tempUpload = multer({ dest: path.join(__dirname, '../uploads/temp') });

// ─── In-memory upload job tracker ────────────────────────────────────────
const uploadJobs = new Map(); // jobId -> { status, track, error, filename, originalname, mimetype, size }

// Upload to library – returns a jobId immediately, processes in background
// This avoids Render's 30-second HTTP request timeout for large Telegram uploads
app.post(
  '/api/library/upload',
  apiLimiter,
  uploadLimiter,
  tempUpload.single('file'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded.' });
    }

    const jobId = require('crypto').randomBytes(12).toString('hex');
    uploadJobs.set(jobId, {
      status: 'processing',
      track: null,
      error: null,
    });

    // Respond immediately with jobId so the HTTP connection closes
    res.json({ ok: true, jobId });

    // Process the upload asynchronously in the background
    (async () => {
      try {
        const track = await libraryManager.addTrack(
          req.file.path,
          req.file.originalname,
          req.file.mimetype,
          req.file.size
        );
        uploadJobs.set(jobId, { status: 'done', track, error: null });
        logger.info('Background upload job completed', { jobId, trackId: track.id });
      } catch (err) {
        // clean up temp file on error
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
          try { fs.unlinkSync(req.file.path); } catch (e) {}
        }
        logger.warn('Background upload job failed', { jobId, filename: req.file.originalname, error: err.message });
        uploadJobs.set(jobId, { status: 'failed', track: null, error: err.message });
      } finally {
        // Clean up job record after 10 minutes
        setTimeout(() => uploadJobs.delete(jobId), 10 * 60 * 1000);
      }
    })();
  }
);

// Poll upload job status
app.get('/api/library/jobs/:jobId', apiLimiter, (req, res) => {
  const { jobId } = req.params;
  const job = uploadJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }
  res.json(job);
});


// Get all library tracks
app.get('/api/library/tracks', apiLimiter, (_req, res) => {
  res.json({ tracks: libraryManager.getTracks() });
});

// Manually trigger a re-sync of the library catalog from Telegram cloud
app.post('/api/library/sync', apiLimiter, async (_req, res) => {
  const telegramBot = require('./telegramBot');
  if (!telegramBot.isEnabled()) {
    return res.status(400).json({ error: 'Telegram Bot is not configured. Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables.' });
  }
  try {
    logger.info('Manual catalog re-sync from Telegram triggered via API...');
    await libraryManager.syncCatalogFromTelegram();
    const tracks = libraryManager.getTracks();
    logger.info('Manual sync complete', { count: tracks.length });
    res.json({ ok: true, count: tracks.length, tracks });
  } catch (err) {
    logger.error('Manual catalog sync failed', { error: err.message });
    res.status(500).json({ error: `Sync failed: ${err.message}` });
  }
});

// Delete a library track
app.delete('/api/library/tracks/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  const deleted = libraryManager.deleteTrack(id);
  if (!deleted) {
    return res.status(404).json({ error: 'Track not found' });
  }
  res.json({ success: true });
});

// Get a single library track metadata
app.get('/api/library/tracks/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  const track = libraryManager.getTrack(id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  res.json({ track });
});

// Upload/bind LRC lyrics text to a library track
app.post('/api/library/tracks/:id/lrc', apiLimiter, express.json(), (req, res) => {
  const { id } = req.params;
  const { lrcText } = req.body;
  const track = libraryManager.getTrack(id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  
  track.lrcText = lrcText || '';
  libraryManager.saveCatalog();
  res.json({ success: true, track });
});

// Sync a local library track to Telegram cloud
app.post('/api/library/tracks/:id/sync', apiLimiter, async (req, res) => {
  const { id } = req.params;
  const track = libraryManager.getTrack(id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  if (track.source === 'telegram') {
    return res.status(400).json({ error: 'Track is already synced to Telegram' });
  }

  const telegramBot = require('./telegramBot');
  if (!telegramBot.isEnabled()) {
    return res.status(400).json({ error: 'Telegram Bot is not configured or active (did you configure env keys and run /start?)' });
  }

  try {
    const filePath = libraryManager.getTrackFilePath(track.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Audio file not found on disk' });
    }

    const buffer = fs.readFileSync(filePath);
    const totalSize = buffer.length;

    // Slice track on-the-fly and upload chunks to Telegram
    logger.info(`Syncing local track ${id} to Telegram...`);
    const totalChunks = Math.max(1, Math.ceil(totalSize / (1024 * 1024 * 2))); // 2MB slices
    const bytesPerChunk = Math.ceil(totalSize / totalChunks);
    const fileIds = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * bytesPerChunk;
      const end = Math.min(totalSize, start + bytesPerChunk);
      const chunkBuffer = buffer.subarray(start, end);
      const chunkName = `${track.id}_chunk_${i}.bin`;

      const fileId = await telegramBot.uploadChunk(chunkBuffer, chunkName);
      fileIds.push(fileId);
    }

    // Update track metadata to switch to Telegram storage
    track.source = 'telegram';
    track.fileIds = fileIds;
    track.filename = null; // Free file association

    // Clean up local disk audio file
    try { fs.unlinkSync(filePath); } catch (e) {}

    libraryManager.saveCatalog();
    logger.info(`Track successfully synced to Telegram: ${id}`, { totalChunks });

    res.json({ success: true, track });
  } catch (err) {
    logger.error('Failed to sync track to Telegram', { trackId: id, error: err.message });
    res.status(500).json({ error: `Sync failed: ${err.message}` });
  }
});

// Download high-quality track (supporting HTTP 206 Range Requests for seeking)
app.get(['/api/library/tracks/:id/download', '/api/library/tracks/:id/download/:filename'], async (req, res) => {
  const { id } = req.params;
  let track = libraryManager.getTrack(id);
  if (!track) {
    // Check if it exists in the R2 PostgreSQL database
    try {
      const r2Track = await db.getTrack(id);
      if (r2Track) {
        const r2 = require('./r2');
        try {
          const range = req.headers.range;
          const r2Response = await r2.getObject(r2Track.audio_key, range);
          
          if (range && r2Response.ContentRange) {
            res.status(206);
            res.setHeader('Content-Range', r2Response.ContentRange);
          } else {
            res.status(200);
          }
          
          if (r2Response.ContentType) {
            res.setHeader('Content-Type', r2Response.ContentType);
          } else {
            res.setHeader('Content-Type', r2Track.format === 'flac' ? 'audio/flac' : 'audio/mpeg');
          }
          
          if (r2Response.ContentLength !== undefined) {
            res.setHeader('Content-Length', r2Response.ContentLength);
          }
          
          res.setHeader('Accept-Ranges', 'bytes');
          
          r2Response.Body.pipe(res);
          return;
        } catch (err) {
          logger.error('Failed to stream R2 track for download', { id, error: err.message });
          return res.status(500).json({ error: 'Failed to stream track from R2' });
        }
      }
    } catch (err) {
      logger.error('Failed to look up R2 track for download', { id, error: err.message });
    }
    return res.status(404).json({ error: 'Track not found' });
  }

  const range = req.headers.range;
  const fileSize = track.fileSize;
  const mimeType = track.mimeType;
  const isDownload = !!req.params.filename;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10) || 0;
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // For Telegram tracks, limit the range size in each HTTP 206 response to at most 2 chunks.
    // This prevents downloading the entire file in parallel from Telegram CDN,
    // resolving playback freezes, slow response times, and socket timeouts for guests.
    if (track.source === 'telegram' && !isDownload) {
      const totalChunks = track.fileIds ? track.fileIds.length : 1;
      const bytesPerChunk = Math.ceil(fileSize / totalChunks);
      const maxRangeSize = Math.max(512 * 1024, bytesPerChunk * 2); // at least 512KB or 2 chunks
      if (end - start + 1 > maxRangeSize) {
        end = start + maxRangeSize - 1;
      }
    }

    if (end >= fileSize) {
      end = fileSize - 1;
    }

    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }

    const chunksize = (end - start) + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', chunksize);
    res.setHeader('Content-Type', mimeType);

    if (isDownload) {
      const safeTitle = (track.title || 'track').replace(/["\\]/g, '');
      let ext = track.source === 'telegram' ? track.originalExtension : path.extname(track.filename || '');
      if (!ext) {
        const mime = (track?.mimeType || '').toLowerCase();
        if (mime.includes('flac')) ext = '.flac';
        else if (mime.includes('wav')) ext = '.wav';
        else if (mime.includes('ogg')) ext = '.ogg';
        else if (mime.includes('aac')) ext = '.aac';
        else if (mime.includes('mp4') || mime.includes('m4a')) ext = '.m4a';
        else ext = '.mp3';
      }
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}${ext}"; filename*=UTF-8''${encodeURIComponent(track.title || 'track')}${ext}`);
    }

    if (track.source === 'telegram') {
      try {
        const totalChunks = track.fileIds.length;
        const bytesPerChunk = Math.ceil(fileSize / totalChunks);
        const startChunkIdx = Math.floor(start / bytesPerChunk);
        const endChunkIdx = Math.floor(end / bytesPerChunk);

        const telegramBot = require('./telegramBot');

        // Fetch all required chunk buffers in parallel
        const chunkIndices = [];
        for (let i = startChunkIdx; i <= endChunkIdx; i++) {
          if (i >= totalChunks) break;
          chunkIndices.push(i);
        }

        const chunkBuffers = await Promise.all(
          chunkIndices.map(i => telegramBot.getChunkBuffer(track.fileIds[i]))
        );

        for (let idx = 0; idx < chunkIndices.length; idx++) {
          const i = chunkIndices[idx];
          const chunkBuffer = chunkBuffers[idx];
          const chunkStartByte = i * bytesPerChunk;
          const sliceStart = Math.max(0, start - chunkStartByte);
          const sliceEnd = Math.min(chunkBuffer.length, end - chunkStartByte + 1);

          if (sliceStart < chunkBuffer.length && sliceEnd > sliceStart) {
            res.write(chunkBuffer.subarray(sliceStart, sliceEnd));
          }
        }
        res.end();
        return;
      } catch (err) {
        logger.error('Telegram Range Proxy failed', { error: err.message });
        return res.status(500).end();
      }
    } else {
      const filePath = libraryManager.getTrackFilePath(track.filename);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Audio file not found on disk. Local upload is unavailable on this ephemeral instance.' });
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  } else {
    // Standard full-file download
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);

    const safeTitle = (track.title || 'track').replace(/["\\]/g, '');
    if (track.source === 'telegram') {
      let ext = track.originalExtension;
      if (!ext) {
        const mime = (track?.mimeType || '').toLowerCase();
        if (mime.includes('flac')) ext = '.flac';
        else if (mime.includes('wav')) ext = '.wav';
        else if (mime.includes('ogg')) ext = '.ogg';
        else if (mime.includes('aac')) ext = '.aac';
        else if (mime.includes('mp4') || mime.includes('m4a')) ext = '.m4a';
        else ext = '.mp3';
      }
      if (isDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}${ext}"; filename*=UTF-8''${encodeURIComponent(track.title || 'track')}${ext}`);
      }
      try {
        const telegramBot = require('./telegramBot');
        for (let i = 0; i < track.fileIds.length; i++) {
          const fileId = track.fileIds[i];
          const chunkBuffer = await telegramBot.getChunkBuffer(fileId);
          res.write(chunkBuffer);
        }
        res.end();
        return;
      } catch (err) {
        logger.error('Failed to proxy Telegram track download', { error: err.message });
        return res.status(500).json({ error: 'Failed to download stream from Cloud' });
      }
    } else {
      const filePath = libraryManager.getTrackFilePath(track.filename);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Audio file not found on disk. Local upload is unavailable on this ephemeral instance.' });
      }
      const ext = path.extname(track.filename) || '.mp3';
      if (isDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}${ext}"; filename*=UTF-8''${encodeURIComponent(track.title || 'track')}${ext}`);
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }
});

// Serve Album cover arts
app.get('/api/library/covers/:filename', async (req, res) => {
  const { filename } = req.params;

  // Intercept R2 requests
  if (filename.startsWith('r2-')) {
    const id = filename.replace(/^r2-/, '').split('.')[0];
    try {
      const track = await db.getTrack(id);
      if (track && track.cover_key) {
        const r2 = require('./r2');
        const url = await r2.getStreamUrl(track.cover_key);
        return res.redirect(url);
      }
    } catch (err) {
      logger.error('Failed to get R2 cover art', { filename, error: err.message });
    }
    return res.status(404).json({ error: 'Cover not found' });
  }

  // Prevent path traversal
  const sanitized = path.basename(filename);
  const coverPath = path.join(__dirname, '../uploads', sanitized);

  if (!fs.existsSync(coverPath)) {
    return res.status(404).json({ error: 'Cover not found' });
  }

  res.setHeader('Content-Type', 'image/jpeg');
  fs.createReadStream(coverPath).pipe(res);
});

// ─── Chunk Download ───────────────────────────────────────────────────────

app.get(
  '/api/rooms/:roomId/chunks/:chunkIndex',
  validateRoomId,
  validateChunkIndex,
  async (req, res) => {
    const { roomId, chunkIndex } = req.params;
    const room  = roomManager.getRoom(roomId);

    if (!room) return res.status(404).json({ error: 'Room not found' });

    const idx = parseInt(chunkIndex, 10);

    // If room is backed by Telegram cloud chunks
    if (room.telegramFileIds) {
      try {
        const chunk = await room.getTelegramChunk(idx);
        if (!chunk) {
          return res.status(404).json({ error: 'Chunk index out of bounds' });
        }
        res.set('Content-Type', chunk.mimeType || 'audio/mpeg');
        res.set('Cache-Control', 'no-store');
        res.set('Access-Control-Allow-Origin', '*');
        res.send(chunk.buffer);
        return;
      } catch (err) {
        logger.error('Failed to proxy Telegram room chunk download', { roomId, idx, error: err.message });
        return res.status(500).json({ error: 'Failed to retrieve chunk from Cloud storage' });
      }
    }

    const chunk = room.getChunk(idx);
    if (!chunk) {
      return res
        .status(404)
        .json({ error: 'Chunk not found — may have been garbage-collected or not yet uploaded.' });
    }

    res.set('Content-Type', chunk.mimeType || 'audio/mpeg');
    res.set('Cache-Control', 'no-store');          // don't cache audio chunks
    res.set('Access-Control-Allow-Origin', '*');   // required for MSE cross-origin
    res.send(chunk.buffer);
  }
);

// ─── 404 + Global error handler ───────────────────────────────────────────

// serve production client assets if in production
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/health') || req.path.startsWith('/admin') || req.path.startsWith('/library')) {
      return next();
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Socket.io Room Logic ─────────────────────────────────────────────────

io.on('connection', (socket) => {
  logger.info('Socket connected', { socketId: socket.id });

  // ── Join Room ──────────────────────────────────────────────────────────
  socket.on('room:join', ({ roomId, role, displayName }) => {
    // Validate roomId format
    if (!roomId || !/^[A-Z0-9]{4,16}$/i.test(roomId)) {
      socket.emit('room:error', { message: 'Invalid room ID format.' });
      return;
    }

    let room = roomManager.getRoom(roomId.toUpperCase());

    if (!room && role === 'host') {
      room = roomManager.createRoom(roomId.toUpperCase());
    }

    if (!room) {
      socket.emit('room:error', { message: 'Room not found. Ask the host to create one first.' });
      return;
    }

    socket.join(roomId.toUpperCase());
    roomManager.addMemberToRoom(roomId.toUpperCase(), socket.id, { role, displayName });

    const state = room.getState();
    socket.emit('room:joined', { roomId: roomId.toUpperCase(), role, state });

    socket.to(roomId.toUpperCase()).emit('room:member_joined', {
      socketId: socket.id,
      displayName,
      role,
      memberCount: room.getMemberCount(),
      members: room.getMembersArray(),
    });

    logger.info('Member joined room', { roomId, displayName, role, members: room.getMemberCount() });
  });

  // ── Host: Load Library Track ──────────────────────────────────────────
  socket.on('host:load_library_track', async ({ roomId, trackId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    const track = libraryManager.getTrack(trackId);
    if (!track) {
      socket.emit('room:error', { message: 'Track not found in library catalog.' });
      return;
    }

    try {
      if (track.source === 'telegram') {
        room.setTelegramLibraryTrack(track);
      } else {
        const filePath = libraryManager.getTrackFilePath(track.filename);
        if (!fs.existsSync(filePath)) {
          logger.warn('Local audio file missing from disk for room track', { roomId, trackId, filename: track.filename });
          socket.emit('room:error', { message: 'Audio file not found on disk. Local upload is unavailable on this ephemeral instance.' });
          return;
        }
        const fileBuffer = fs.readFileSync(filePath);
        room.setLibraryTrack(track, fileBuffer);
      }

      // Parse lyrics if track has lyrics text
      let lyrics = [];
      let lrcMeta = {};
      if (track.lrcText) {
        const { parseLrc } = require('./lrcParser');
        const parsed = parseLrc(track.lrcText);
        lyrics = parsed.lines;
        lrcMeta = {
          title: parsed.meta.title || track.title,
          artist: parsed.meta.artist || track.artist
        };
      } else {
        lrcMeta = {
          title: track.title,
          artist: track.artist
        };
      }
      room.setState({ lyrics, lrcMeta });

      // Broadcast state to all users in the room
      io.to(roomId).emit('sync:track_loaded', room.getState());
      logger.info('Library track loaded in room', { roomId, trackId, title: track.title, source: track.source });
    } catch (err) {
      logger.error('Failed to load track file into room', { error: err.message });
      socket.emit('room:error', { message: 'Failed to read track audio.' });
    }
  });

  // ── Host: Update Track Metadata ──
  socket.on('host:update_track_metadata', (data) => {
    const { roomId, ...metadata } = data;
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    const updates = {};
    if (metadata.songName !== undefined) updates.songName = metadata.songName;
    if (metadata.totalChunks !== undefined) {
      updates.totalChunks = metadata.totalChunks ? parseInt(metadata.totalChunks, 10) : null;
    }
    if (metadata.mimeType !== undefined) updates.mimeType = metadata.mimeType;
    if (metadata.lyrics !== undefined) updates.lyrics = metadata.lyrics;
    if (metadata.lrcMeta !== undefined) updates.lrcMeta = metadata.lrcMeta;
    if (metadata.libraryTrackId !== undefined) updates.libraryTrackId = metadata.libraryTrackId;
    if (metadata.coverFilename !== undefined) updates.coverFilename = metadata.coverFilename;

    room.setState(updates);

    io.to(roomId).emit('sync:track_loaded', room.getState());
    logger.info('Track metadata updated in room', { roomId, songName: room.state.songName, totalChunks: room.state.totalChunks });
  });

  // ── Host: Update Queue ──
  socket.on('host:update_queue', ({ roomId, queue, currentQueueIndex }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    room.setState({
      queue: queue || [],
      currentQueueIndex: currentQueueIndex !== undefined ? currentQueueIndex : -1
    });

    io.to(roomId).emit('sync:track_loaded', room.getState());
    logger.debug('Queue updated in room', { roomId, queueSize: (queue || []).length, currentIndex: currentQueueIndex });
  });

  // ── Host: Play ────────────────────────────────────────────────────────
  socket.on('host:play', ({ roomId, currentTime, chunkIndex }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    // Schedule 250ms ahead so all clients can buffer and start together
    const scheduledStartTime = Date.now() + 250;
    room.setState({ isPlaying: true, currentTime, chunkIndex, scheduledStartTime });

    io.to(roomId).emit('sync:play', { scheduledStartTime, currentTime, chunkIndex });
    logger.info('Play scheduled', { roomId, currentTime, chunkIndex, scheduledStartTime });
  });

  // ── Host: Pause ───────────────────────────────────────────────────────
  socket.on('host:pause', ({ roomId, currentTime }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    room.setState({ isPlaying: false, currentTime, scheduledStartTime: null });
    io.to(roomId).emit('sync:pause', { currentTime });
    logger.info('Paused', { roomId, currentTime });
  });

  // ── Host: Seek ────────────────────────────────────────────────────────
  socket.on('host:seek', ({ roomId, currentTime, chunkIndex }) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    const updates = { currentTime, chunkIndex };
    if (room.state.isPlaying) {
      updates.scheduledStartTime = Date.now() + 250;
    }
    room.setState(updates);
    room.gcOldChunks(chunkIndex);

    io.to(roomId).emit('sync:seek', updates);
    logger.info('Seek', { roomId, currentTime, chunkIndex, scheduledStartTime: updates.scheduledStartTime });
  });

  // ── Host: Chunk playing (trigger GC) ─────────────────────────────────
  socket.on('host:chunk_playing', ({ roomId, chunkIndex }) => {
    const room = roomManager.getRoom(roomId);
    if (room) room.gcOldChunks(chunkIndex);
  });

  // ── NTP ping/pong ─────────────────────────────────────────────────────
  socket.on('ntp:ping', ({ clientSendTime }) => {
    socket.emit('ntp:pong', { clientSendTime, serverTime: Date.now() });
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    const roomId = roomManager.removeMember(socket.id);
    logger.info('Socket disconnected', { socketId: socket.id, reason, roomId });

    if (roomId) {
      const room = roomManager.getRoom(roomId);
      if (room) {
        io.to(roomId).emit('room:member_left', {
          socketId: socket.id,
          memberCount: room.getMemberCount(),
          members: room.getMembersArray(),
        });
      }
    }
  });

  // ── Error ─────────────────────────────────────────────────────────────
  socket.on('error', (err) => {
    logger.error('Socket error', { socketId: socket.id, error: err.message });
  });
});

// ─── Start server ─────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3001', 10);

async function startServer() {
  // ── Initialize PostgreSQL schema ─────────────────────────────────────────
  if (process.env.DATABASE_URL) {
    try {
      await db.initDb();
    } catch (err) {
      logger.error('Failed to initialize PostgreSQL schema — R2 library routes will not work', { error: err.message });
    }
  } else {
    logger.warn('DATABASE_URL not set — R2 library routes require a PostgreSQL database');
  }

  // Sync library catalog from Telegram cloud if active
  try {
    const telegramBot = require('./telegramBot');
    if (telegramBot.isEnabled()) {
      logger.info('Syncing library catalog from Telegram cloud on startup...');
      // Give Telegram bot polling 3s to settle before we try to read the pinned message
      await new Promise(r => setTimeout(r, 3000));
      await libraryManager.syncCatalogFromTelegram();
      logger.info('Startup Telegram sync complete', { count: libraryManager.getTracks().length });
    } else {
      logger.warn('Telegram not enabled on startup — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing');
    }
  } catch (err) {
    logger.error('Failed to sync catalog from Telegram on startup', { error: err.message });
  }

  server.listen(PORT, () => {
    logger.info(`NoirSync server running`, {
      port: PORT,
      env: process.env.NODE_ENV || 'development',
      cors: corsOrigin,
    });
  });
}

startServer();

// ─── Graceful shutdown ────────────────────────────────────────────────────
// Ensures in-flight requests complete and Socket.io closes cleanly.

function gracefulShutdown(signal) {
  logger.warn(`Received ${signal} — starting graceful shutdown`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
    roomManager.destroy();
    process.exit(0);
  });

  // Force-exit after 10 s if still hanging
  setTimeout(() => {
    logger.error('Shutdown timeout — forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});
