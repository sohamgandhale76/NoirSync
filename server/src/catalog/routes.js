// ─── Universal Music Catalog API Routes ─────────────────────────────────────
// Express router for multi-provider search, browse, streaming, and download.

const express = require('express');
const router = express.Router();
const catalogDb = require('./db');
const { resolveProviderTrack } = require('../music/resolver');
const { getMusicProvider, isCanonicalProvider } = require('../music/registry');
const r2 = require('../r2');
const logger = require('../logger');

// GET /api/catalog/search — Search across database and live external providers
router.get('/search', async (req, res) => {
  try {
    const { q, provider, limit, offset } = req.query;
    const results = await catalogDb.searchCatalog({
      query: q || '',
      provider: provider ? String(provider) : undefined,
      limit: limit ? parseInt(String(limit), 10) : 20,
      offset: offset ? parseInt(String(offset), 10) : 0
    });
    res.json(results);
  } catch (err) {
    logger.error('Catalog search error', { error: err.message });
    res.status(500).json({ error: 'Failed to search catalog' });
  }
});

// GET /api/catalog/browse — Browse published catalog tracks
router.get('/browse', async (req, res) => {
  try {
    const { category, provider, limit, offset } = req.query;
    const results = await catalogDb.browseCatalog({
      category: category ? String(category) : undefined,
      provider: provider ? String(provider) : undefined,
      limit: limit ? parseInt(String(limit), 10) : 20,
      offset: offset ? parseInt(String(offset), 10) : 0
    });
    res.json(results);
  } catch (err) {
    logger.error('Catalog browse error', { error: err.message });
    res.status(500).json({ error: 'Failed to browse catalog' });
  }
});

// GET /api/catalog/tracks/:id — Track details with server-computed capabilities
router.get('/tracks/:id', async (req, res) => {
  try {
    const track = await catalogDb.getCatalogTrack(req.params.id);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }
    res.json({ track });
  } catch (err) {
    logger.error('Catalog track lookup error', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Failed to fetch catalog track' });
  }
});

// GET /api/catalog/tracks/:id/stream — Stream authorized NoirSync public audio
router.get('/tracks/:id/stream', async (req, res) => {
  try {
    const track = await catalogDb.getCatalogTrackForStream(req.params.id);

    const rangeHeader = req.headers.range;
    const s3Res = await r2.getObject(track.audio_key, rangeHeader);

    if (rangeHeader && s3Res.ContentRange) {
      res.status(206);
      res.setHeader('Content-Range', s3Res.ContentRange);
      res.setHeader('Accept-Ranges', 'bytes');
    }
    if (s3Res.ContentLength) {
      res.setHeader('Content-Length', s3Res.ContentLength);
    }
    res.setHeader('Content-Type', s3Res.ContentType || 'audio/mpeg');

    if (s3Res.Body && typeof s3Res.Body.pipe === 'function') {
      s3Res.Body.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error('Catalog stream error', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Failed to stream track' });
  }
});

// GET /api/catalog/tracks/:id/download — Download authorized NoirSync public audio
router.get('/tracks/:id/download', async (req, res) => {
  try {
    const track = await catalogDb.getCatalogTrackForDownload(req.params.id);

    const ext = track.format || 'mp3';
    const safeTitle = (track.title || 'track').replace(/[^a-zA-Z0-9_\- ]/g, '').trim();
    const filename = `${safeTitle || 'track'}.${ext}`;

    const s3Res = await r2.getObject(track.audio_key);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', s3Res.ContentType || 'audio/mpeg');
    if (s3Res.ContentLength) {
      res.setHeader('Content-Length', s3Res.ContentLength);
    }

    if (s3Res.Body && typeof s3Res.Body.pipe === 'function') {
      s3Res.Body.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error('Catalog download error', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Failed to download track' });
  }
});

// GET /api/catalog/tracks/:id/cover — Public cover art for catalog tracks
router.get('/tracks/:id/cover', async (req, res) => {
  try {
    const track = await catalogDb.getCatalogTrack(req.params.id);
    if (!track || !track.coverUrl) {
      return res.status(404).json({ error: 'Cover not found' });
    }
    if (track.coverUrl.startsWith('http://') || track.coverUrl.startsWith('https://')) {
      return res.redirect(track.coverUrl);
    }
    // If it's an R2 key
    const s3Res = await r2.getObject(track.coverUrl);
    res.setHeader('Content-Type', s3Res.ContentType || 'image/jpeg');
    if (s3Res.Body && typeof s3Res.Body.pipe === 'function') {
      s3Res.Body.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    res.status(404).json({ error: 'Cover not found' });
  }
});

// POST /api/catalog/tracks/:id/resolve — Resolve track to canonical tracks.id for playlist addition
router.post('/tracks/:id/resolve', async (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id } = req.params;
  const { provider, providerTrackId } = req.body || {};

  try {
    // 1. If an existing canonical track ID is provided and exists in catalog
    if (id && id !== 'resolve') {
      const existing = await catalogDb.getCatalogTrack(id);
      if (existing) {
        return res.json({ trackId: existing.id, track: existing });
      }
    }

    // 2. If provider and providerTrackId are provided, resolve authoritatively
    const targetProvider = provider ? String(provider).toLowerCase() : null;
    const targetTrackId = providerTrackId ? String(providerTrackId) : null;

    if (!targetProvider || !targetTrackId) {
      return res.status(400).json({ error: 'provider and providerTrackId are required' });
    }

    if (!isCanonicalProvider(targetProvider)) {
      return res.status(400).json({ error: `Unsupported provider: ${targetProvider}` });
    }

    const adapter = getMusicProvider(targetProvider);
    let authoritativeTrack = null;
    try {
      authoritativeTrack = await adapter.getTrack(targetTrackId);
    } catch (adapterErr) {
      return res.status(adapterErr.status || 404).json({ error: adapterErr.message || 'Track not found in provider' });
    }

    if (!authoritativeTrack) {
      return res.status(404).json({ error: 'Track not found in provider' });
    }

    // Resolve into canonical tracks table using authoritative metadata ONLY
    const resolved = await resolveProviderTrack({
      provider: authoritativeTrack.provider,
      providerTrackId: authoritativeTrack.providerTrackId,
      title: authoritativeTrack.title,
      artist: authoritativeTrack.artist,
      duration: authoritativeTrack.duration,
      coverUrl: authoritativeTrack.coverUrl,
      album: authoritativeTrack.album,
      externalUrl: authoritativeTrack.externalUrl
    });

    res.json({
      trackId: resolved.id,
      track: catalogDb.formatUniversalTrack(resolved)
    });
  } catch (err) {
    logger.error('Catalog resolve error', { error: err.message });
    res.status(err.status || 500).json({ error: err.message || 'Failed to resolve catalog track' });
  }
});

// POST /api/catalog/resolve — Alternate endpoint for resolving without path param
router.post('/resolve', (req, res) => {
  req.params.id = 'resolve';
  return router.handle(req, res);
});

module.exports = router;
