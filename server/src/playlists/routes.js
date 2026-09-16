// ─── Playlists API Routes ──────────────────────────────────────────────────
// Express router for persistent playlists and universal tracks.

const express = require('express');
const logger = require('../logger');
const playlistDb = require('./db');

const router = express.Router();

/**
 * Authentication check middleware for playlist routes.
 */
router.use((req, res, next) => {
  if (!req.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// GET /api/playlists — List user's playlists with track counts
router.get('/', async (req, res) => {
  try {
    const playlists = await playlistDb.getUserPlaylists(req.userId);
    res.json({ playlists });
  } catch (err) {
    logger.error('Error fetching user playlists', { userId: req.userId, error: err.message });
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// POST /api/playlists — Create a new playlist
router.post('/', async (req, res) => {
  const { name, description } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Playlist name is required and must not be empty' });
  }

  if (name.trim().length > 255) {
    return res.status(400).json({ error: 'Playlist name must not exceed 255 characters' });
  }

  if (description !== undefined && description !== null && typeof description !== 'string') {
    return res.status(400).json({ error: 'Description must be a string' });
  }

  try {
    const playlist = await playlistDb.createPlaylist(req.userId, name, description);
    logger.info('Playlist created', { userId: req.userId, playlistId: playlist.id, name: playlist.name });
    res.status(201).json({ playlist });
  } catch (err) {
    logger.error('Error creating playlist', { userId: req.userId, error: err.message });
    res.status(err.status || 500).json({ error: err.message || 'Failed to create playlist' });
  }
});

// GET /api/playlists/:id — Get playlist details and ordered tracks
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const playlist = await playlistDb.getPlaylistById(id, req.userId);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    res.json({ playlist });
  } catch (err) {
    logger.error('Error fetching playlist', { userId: req.userId, playlistId: id, error: err.message });
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

// PATCH /api/playlists/:id — Update playlist name/description
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body || {};

  const updates = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Playlist name must not be empty' });
    }
    if (name.trim().length > 255) {
      return res.status(400).json({ error: 'Playlist name must not exceed 255 characters' });
    }
    updates.name = name.trim();
  }

  if (description !== undefined) {
    if (description !== null && typeof description !== 'string') {
      return res.status(400).json({ error: 'Description must be a string or null' });
    }
    updates.description = description ? description.trim() : null;
  }

  try {
    const playlist = await playlistDb.updatePlaylist(id, req.userId, updates);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    logger.info('Playlist updated', { userId: req.userId, playlistId: id });
    res.json({ playlist });
  } catch (err) {
    logger.error('Error updating playlist', { userId: req.userId, playlistId: id, error: err.message });
    res.status(err.status || 500).json({ error: err.message || 'Failed to update playlist' });
  }
});

// DELETE /api/playlists/:id — Delete playlist
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const deleted = await playlistDb.deletePlaylist(id, req.userId);
    if (!deleted) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    logger.info('Playlist deleted', { userId: req.userId, playlistId: id });
    res.json({ success: true });
  } catch (err) {
    logger.error('Error deleting playlist', { userId: req.userId, playlistId: id, error: err.message });
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

// POST /api/playlists/:id/tracks — Add a track to playlist
router.post('/:id/tracks', async (req, res) => {
  const { id } = req.params;
  const { trackId, trackData } = req.body || {};

  if (!trackId && !trackData) {
    return res.status(400).json({ error: 'trackId or trackData is required' });
  }

  try {
    const result = await playlistDb.addTrackToPlaylist(id, req.userId, trackId, trackData);
    logger.info('Track added to playlist', { userId: req.userId, playlistId: id, trackId: result.track_id });
    res.status(201).json({ success: true, item: result });
  } catch (err) {
    if (err.status === 409 || err.code === '23505') {
      return res.status(409).json({ error: 'Track is already in this playlist' });
    }
    if (err.status === 404) {
      return res.status(404).json({ error: err.message || 'Playlist or track not found' });
    }
    logger.error('Error adding track to playlist', { userId: req.userId, playlistId: id, error: err.message });
    res.status(err.status || 500).json({ error: err.message || 'Failed to add track to playlist' });
  }
});

// DELETE /api/playlists/:id/tracks/:trackId — Remove track from playlist
router.delete('/:id/tracks/:trackId', async (req, res) => {
  const { id, trackId } = req.params;

  try {
    await playlistDb.removeTrackFromPlaylist(id, req.userId, trackId);
    logger.info('Track removed from playlist', { userId: req.userId, playlistId: id, trackId });
    res.json({ success: true });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message || 'Track or playlist not found' });
    }
    logger.error('Error removing track from playlist', { userId: req.userId, playlistId: id, trackId, error: err.message });
    res.status(err.status || 500).json({ error: err.message || 'Failed to remove track from playlist' });
  }
});

// PATCH /api/playlists/:id/tracks/reorder — Reorder tracks in playlist
router.patch('/:id/tracks/reorder', async (req, res) => {
  const { id } = req.params;
  const { trackIds } = req.body || {};

  if (!Array.isArray(trackIds)) {
    return res.status(400).json({ error: 'trackIds must be an array' });
  }

  try {
    const playlist = await playlistDb.reorderPlaylistTracks(id, req.userId, trackIds);
    logger.info('Playlist tracks reordered', { userId: req.userId, playlistId: id, count: trackIds.length });
    res.json({ success: true, playlist });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message || 'Playlist not found' });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    logger.error('Error reordering playlist tracks', { userId: req.userId, playlistId: id, error: err.message });
    res.status(err.status || 500).json({ error: err.message || 'Failed to reorder playlist tracks' });
  }
});

module.exports = router;
