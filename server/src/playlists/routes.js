const express = require('express');
const logger = require('../logger');
const playlistDb = require('./db');
const { getUserAccessToken, getSpotifyClientCredentialsToken } = require('../music/providers/credentials');
const { isDevFixturesEnabled, getDevFixturePlaylist } = require('../music/providers/fixtures');

const router = express.Router();

/**
 * Robustly extracts the Spotify playlist ID from URLs, query parameters, or URIs.
 * Supports:
 * - https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=...
 * - open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
 * - spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
 * - 22-character raw alphanumeric ID
 * 
 * @param {string} input 
 * @returns {string|null}
 */
function extractSpotifyPlaylistId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // Handle spotify:playlist:ID
  const uriMatch = trimmed.match(/^spotify:playlist:([a-zA-Z0-9]+)/i);
  if (uriMatch) return uriMatch[1];

  // Handle URLs like https://open.spotify.com/playlist/ID
  const urlMatch = trimmed.match(/(?:https?:\/\/)?(?:open\.)?spotify\.com\/playlist\/([a-zA-Z0-9]+)/i);
  if (urlMatch) return urlMatch[1];

  // If raw alphanumeric Spotify ID (typically 22 chars)
  if (/^[a-zA-Z0-9]{22}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

/**
 * Fetches playlist metadata and all paginated tracks from Spotify Web API.
 * Uses connected user token if available, or client credentials token for public playlists.
 * 
 * @param {string} playlistId 
 * @param {string} userId 
 * @returns {Promise<Object>}
 */
async function fetchSpotifyPlaylist(playlistId, userId) {
  // Check dev fixtures first if enabled in test/dev
  if (isDevFixturesEnabled()) {
    const fixture = getDevFixturePlaylist(playlistId);
    if (fixture) {
      return fixture;
    }
  }

  let userToken = null;
  if (userId) {
    try {
      userToken = await getUserAccessToken(userId, 'spotify');
    } catch {
      userToken = null;
    }
  }

  // Helper to make Spotify request with specific token
  async function callSpotify(endpoint, token) {
    const url = endpoint.startsWith('http') ? endpoint : `https://api.spotify.com/v1${endpoint}`;
    return fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
  }

  let token = userToken;
  let isUserAuth = Boolean(userToken);
  let res;

  try {
    if (!token) {
      token = await getSpotifyClientCredentialsToken();
      isUserAuth = false;
    }

    res = await callSpotify(`/playlists/${playlistId}`, token);

    // If 401 with user token, try fallback to client credentials
    if (res.status === 401 && isUserAuth) {
      try {
        token = await getSpotifyClientCredentialsToken();
        isUserAuth = false;
        res = await callSpotify(`/playlists/${playlistId}`, token);
      } catch {}
    }
  } catch (fetchErr) {
    logger.warn('Spotify playlist fetch error:', { playlistId, error: fetchErr.message });
    const err = new Error('Spotify playlist not found or is private. Connect your Spotify account in Settings to import private playlists.');
    err.status = 404;
    throw err;
  }

  if (!res.ok) {
    if (res.status === 404) {
      if (!isUserAuth) {
        const err = new Error('Spotify playlist not found or is private. Connect your Spotify account in Settings to import private playlists.');
        err.status = 404;
        throw err;
      }
      const err = new Error('Spotify playlist not found');
      err.status = 404;
      throw err;
    }
    if (res.status === 403) {
      const err = new Error('Access denied to Spotify playlist. Please ensure your Spotify account has access.');
      err.status = 403;
      throw err;
    }
    if (res.status === 429) {
      const err = new Error('Spotify rate limit exceeded. Please try again in a few moments.');
      err.status = 429;
      throw err;
    }
    const errBody = await res.text().catch(() => '');
    const err = new Error(`Spotify API error (HTTP ${res.status}): ${errBody}`);
    err.status = res.status;
    throw err;
  }

  const playlistData = await res.json();
  const name = playlistData.name || 'Imported Spotify Playlist';
  const description = playlistData.description || null;
  const coverUrl = playlistData.images && playlistData.images.length > 0 ? playlistData.images[0].url : null;

  // Collect items from initial page
  let allItems = [];
  if (playlistData.tracks && Array.isArray(playlistData.tracks.items) && playlistData.tracks.items.length > 0) {
    allItems = [...playlistData.tracks.items];
  } else if (Array.isArray(playlistData.tracks) && playlistData.tracks.length > 0) {
    allItems = [...playlistData.tracks];
  } else if (Array.isArray(playlistData.items) && playlistData.items.length > 0) {
    allItems = [...playlistData.items];
  }

  let nextUrl = playlistData.tracks ? playlistData.tracks.next : null;

  // If initial playlist payload had no track items, query playlist tracks endpoint directly
  if (allItems.length === 0) {
    try {
      const tracksRes = await callSpotify(`/playlists/${playlistId}/tracks?limit=100`, token);
      if (tracksRes.ok) {
        const tracksPage = await tracksRes.json();
        if (tracksPage && Array.isArray(tracksPage.items)) {
          allItems = [...tracksPage.items];
          nextUrl = tracksPage.next || null;
        }
      } else {
        logger.warn('Direct playlist tracks fetch returned non-ok status', { status: tracksRes.status });
      }
    } catch (tracksErr) {
      logger.warn('Error fetching playlist tracks endpoint directly:', { error: tracksErr.message });
    }
  }

  // Paginate if next URL exists until all tracks are fetched
  while (nextUrl) {
    try {
      const nextRes = await callSpotify(nextUrl, token);
      if (!nextRes.ok) {
        logger.warn('Spotify playlist pagination failed at URL:', { nextUrl, status: nextRes.status });
        break;
      }
      const pageData = await nextRes.json();
      if (pageData && Array.isArray(pageData.items)) {
        allItems = allItems.concat(pageData.items);
      }
      nextUrl = pageData ? pageData.next : null;
    } catch (pageErr) {
      logger.warn('Spotify playlist pagination error:', { error: pageErr.message });
      break;
    }
  }

  return {
    id: playlistData.id,
    name,
    description,
    coverUrl,
    items: allItems
  };
}

/**
 * Authentication check middleware for playlist routes.
 */
router.use((req, res, next) => {
  if (!req.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// POST /api/playlists/import/spotify — Import playlist from Spotify Web API
router.post('/import/spotify', async (req, res) => {
  const { playlistUrl } = req.body || {};

  if (!playlistUrl || typeof playlistUrl !== 'string' || !playlistUrl.trim()) {
    return res.status(400).json({ error: 'playlistUrl is required' });
  }

  const playlistId = extractSpotifyPlaylistId(playlistUrl);
  if (!playlistId) {
    return res.status(400).json({ error: 'Invalid Spotify playlist URL or URI' });
  }

  try {
    const spotifyData = await fetchSpotifyPlaylist(playlistId, req.userId);
    const result = await playlistDb.importSpotifyPlaylist(req.userId, spotifyData);
    logger.info('Spotify playlist imported successfully', {
      userId: req.userId,
      playlistId: result.playlist.id,
      name: result.playlist.name,
      added: result.summary.added
    });
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    logger.error('Error importing Spotify playlist', { userId: req.userId, playlistUrl, error: err.message });
    res.status(err.status || 500).json({ error: err.message || 'Failed to import Spotify playlist' });
  }
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
