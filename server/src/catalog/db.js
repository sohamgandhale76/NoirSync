// ─── Catalog PostgreSQL Database & Discovery Layer ─────────────────────────
// Multi-provider search, browse, track lookup, and server-authoritative capabilities.

const { pool } = require('../db');
const { getMusicProvider, getAvailableProviders } = require('../music/registry');
const logger = require('../logger');

/**
 * Server-authoritative capability computation for a track.
 * The client MUST NEVER decide playback or download capabilities.
 * 
 * @param {Object} track 
 * @returns {{ playback: 'none'|'external_link'|'embedded_player'|'noirsync_stream', download: boolean, addToPlaylist: boolean }}
 */
function computeTrackCapabilities(track) {
  if (!track) {
    return { playback: 'none', download: false, addToPlaylist: false };
  }

  let playback = 'none';
  if (track.provider === 'noirsync_public' && track.publication_status === 'published') {
    playback = 'noirsync_stream';
  } else if (track.provider === 'youtube') {
    playback = 'embedded_player';
  } else if (track.provider === 'spotify' || track.provider === 'apple') {
    playback = 'external_link';
  }

  // Download capability: STRICTLY false for external providers
  const download = track.provider === 'noirsync_public' &&
                   track.publication_status === 'published' &&
                   Boolean(track.download_allowed);

  return {
    playback,
    download,
    addToPlaylist: true
  };
}

/**
 * Formats any database row or provider track into the unified UniversalTrack representation.
 * Guarantees that internal storage keys (audio_key, lyrics_key) and user ownership fields are NOT leaked.
 * 
 * @param {Object} track 
 * @returns {Object|null}
 */
function formatUniversalTrack(track) {
  if (!track) return null;

  const provider = track.provider;
  const providerTrackId = track.provider_track_id || track.providerTrackId || null;

  let coverUrl = null;
  if (track.cover_key) {
    coverUrl = (track.cover_key.startsWith('http://') || track.cover_key.startsWith('https://'))
      ? track.cover_key
      : `/api/catalog/tracks/${track.id}/cover`;
  } else if (track.coverUrl) {
    coverUrl = track.coverUrl;
  }

  // Issue D: If YouTube track has no cover but has a providerTrackId, use standard YouTube thumbnail
  if (!coverUrl && provider === 'youtube' && providerTrackId) {
    const cleanYtId = String(providerTrackId).replace(/^yt_/, '');
    if (cleanYtId) {
      coverUrl = `https://i.ytimg.com/vi/${cleanYtId}/hqdefault.jpg`;
    }
  }

  return {
    id: track.id || null,
    title: track.title,
    artist: track.artist || 'Unknown Artist',
    album: track.album || null,
    duration: track.duration ? Number(track.duration) : null,
    provider,
    providerTrackId,
    coverUrl,
    externalUrl: track.external_url || track.externalUrl || null,
    publicationStatus: track.publication_status || 'published',
    downloadAllowed: Boolean(track.download_allowed),
    capabilities: computeTrackCapabilities(track)
  };
}

/**
 * Search the universal music catalog across canonical database records and live external providers.
 * Uses Promise.allSettled so a failure on one provider never breaks the entire search.
 * 
 * @param {{ query: string, provider?: string, limit?: number, offset?: number }} params 
 * @returns {Promise<{ tracks: Array<Object>, total: number }>}
 */
async function searchCatalog({ query, provider, limit = 20, offset = 0 }) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { tracks: [], total: 0 };
  }

  const trimmedQuery = query.trim();
  const pattern = `%${trimmedQuery}%`;
  const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const off = Math.max(0, parseInt(offset, 10) || 0);

  // 1. Search existing canonical DB tracks (strictly user_id IS NULL AND published AND provider != 'local')
  const dbParams = [pattern];
  let dbQuery = `
    SELECT * FROM tracks
    WHERE user_id IS NULL
      AND publication_status = 'published'
      AND provider != 'local'
      AND (
        title ILIKE $1 OR
        artist ILIKE $1 OR
        album ILIKE $1
      )
  `;

  if (provider && provider.trim()) {
    dbParams.push(provider.trim().toLowerCase());
    dbQuery += ` AND provider = $2`;
  }

  dbQuery += ` ORDER BY uploaded_at DESC LIMIT 50`;

  let dbRows = [];
  try {
    const dbRes = await pool.query(dbQuery, dbParams);
    dbRows = dbRes.rows;
  } catch (err) {
    logger.error('Catalog DB search error', { error: err.message });
  }

  // 2. Query external providers in parallel using Promise.allSettled
  const targetProviders = provider
    ? [provider.trim().toLowerCase()]
    : getAvailableProviders();

  const providerPromises = targetProviders.map(async (pName) => {
    try {
      const adapter = getMusicProvider(pName);
      if (!adapter) return [];
      const results = await adapter.search(trimmedQuery);
      return Array.isArray(results) ? results : [];
    } catch (err) {
      // Gracefully ignore unconfigured / rate-limited / unavailable providers
      logger.debug('Provider search non-fatal error', { provider: pName, error: err.message });
      return [];
    }
  });

  const settled = await Promise.allSettled(providerPromises);
  const liveTracks = [];
  for (const res of settled) {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      liveTracks.push(...res.value);
    }
  }

  // 3. Deduplicate by (provider, providerTrackId)
  // Database rows take precedence for canonical tracks.id, but live provider results enrich missing/invalid coverUrl
  const trackMap = new Map();

  for (const row of dbRows) {
    const key = `${row.provider}:${row.provider_track_id || row.id}`;
    trackMap.set(key, formatUniversalTrack(row));
  }

  for (const live of liveTracks) {
    const key = `${live.provider}:${live.providerTrackId}`;
    if (trackMap.has(key)) {
      // Issue C: If existing DB entry has missing or truncated/invalid coverUrl, but live has a valid coverUrl, enrich it!
      const existing = trackMap.get(key);
      const isInvalidCover = !existing.coverUrl || 
                             (existing.coverUrl.startsWith('https://i.scdn.co/image/') && existing.coverUrl.length < 50);
      if (isInvalidCover && live.coverUrl) {
        existing.coverUrl = live.coverUrl;
      }
    } else {
      trackMap.set(key, formatUniversalTrack({
        ...live,
        publication_status: 'published',
        download_allowed: false
      }));
    }
  }

  const allTracks = Array.from(trackMap.values());
  const paginated = allTracks.slice(off, off + lim);

  return {
    tracks: paginated,
    total: allTracks.length
  };
}

/**
 * Browse published canonical catalog tracks.
 * 
 * @param {{ category?: string, provider?: string, limit?: number, offset?: number }} params 
 * @returns {Promise<{ tracks: Array<Object>, total: number }>}
 */
async function browseCatalog({ category, provider, limit = 20, offset = 0 }) {
  const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const off = Math.max(0, parseInt(offset, 10) || 0);

  const params = [];
  let query = `
    SELECT * FROM tracks
    WHERE user_id IS NULL
      AND publication_status = 'published'
      AND provider != 'local'
  `;

  if (provider && provider.trim()) {
    params.push(provider.trim().toLowerCase());
    query += ` AND provider = $${params.length}`;
  }

  query += ` ORDER BY uploaded_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(lim, off);

  const res = await pool.query(query, params);
  const tracks = res.rows.map(row => formatUniversalTrack(row));

  // Count total
  const countRes = await pool.query(`
    SELECT COUNT(*)::int AS total FROM tracks
    WHERE user_id IS NULL
      AND publication_status = 'published'
      AND provider != 'local'
      ${provider ? `AND provider = $1` : ''}
  `, provider ? [provider.trim().toLowerCase()] : []);

  return {
    tracks,
    total: countRes.rows[0]?.total || tracks.length
  };
}

/**
 * Get a single catalog track by its canonical ID.
 * Strictly verifies that the track is public (user_id IS NULL AND published AND provider != 'local').
 * 
 * @param {string} id 
 * @returns {Promise<Object|null>}
 */
async function getCatalogTrack(id) {
  if (!id) return null;

  const res = await pool.query(`
    SELECT * FROM tracks
    WHERE id = $1
      AND user_id IS NULL
      AND publication_status = 'published'
      AND provider != 'local'
  `, [id]);

  if (res.rows.length === 0) {
    return null;
  }

  return formatUniversalTrack(res.rows[0]);
}

/**
 * Retrieve a catalog track for native audio streaming.
 * Invariants:
 * - Must be user_id IS NULL
 * - Must be provider === 'noirsync_public'
 * - Must be publication_status === 'published'
 * - Must have audio_key
 * - audio_key MUST NOT start with users/
 * 
 * @param {string} id 
 * @returns {Promise<Object>}
 */
async function getCatalogTrackForStream(id) {
  if (!id) {
    const err = new Error('Track ID is required');
    err.status = 400;
    throw err;
  }

  const res = await pool.query('SELECT * FROM tracks WHERE id = $1', [id]);
  if (res.rows.length === 0) {
    const err = new Error('Track not found');
    err.status = 404;
    throw err;
  }

  const track = res.rows[0];

  // Private tracks can NEVER be streamed through catalog
  if (track.user_id !== null) {
    const err = new Error('Track not found');
    err.status = 404;
    throw err;
  }

  // External providers can NEVER be streamed through NoirSync server
  if (track.provider !== 'noirsync_public') {
    const err = new Error('External provider tracks cannot be streamed directly. Use provider playback.');
    err.status = 403;
    throw err;
  }

  // Draft or archived tracks cannot be streamed
  if (track.publication_status !== 'published') {
    const err = new Error('Track is not published');
    err.status = 403;
    throw err;
  }

  if (!track.audio_key) {
    const err = new Error('Audio file not found for track');
    err.status = 404;
    throw err;
  }

  // Namespace protection: never access users/
  if (track.audio_key.startsWith('users/')) {
    const err = new Error('Forbidden storage namespace');
    err.status = 403;
    throw err;
  }

  return track;
}

/**
 * Retrieve a catalog track for downloading.
 * Invariants:
 * - Must be user_id IS NULL
 * - Must be provider === 'noirsync_public'
 * - Must be publication_status === 'published'
 * - Must have download_allowed === true
 * - audio_key MUST NOT start with users/
 * 
 * @param {string} id 
 * @returns {Promise<Object>}
 */
async function getCatalogTrackForDownload(id) {
  if (!id) {
    const err = new Error('Track ID is required');
    err.status = 400;
    throw err;
  }

  const res = await pool.query('SELECT * FROM tracks WHERE id = $1', [id]);
  if (res.rows.length === 0) {
    const err = new Error('Track not found');
    err.status = 404;
    throw err;
  }

  const track = res.rows[0];

  // Private tracks can NEVER be downloaded through catalog
  if (track.user_id !== null) {
    const err = new Error('Track not found');
    err.status = 404;
    throw err;
  }

  // External providers can NEVER be downloaded
  if (track.provider !== 'noirsync_public') {
    const err = new Error('Downloads are not permitted for external provider tracks');
    err.status = 403;
    throw err;
  }

  // Draft or archived tracks cannot be downloaded
  if (track.publication_status !== 'published') {
    const err = new Error('Track is not published');
    err.status = 403;
    throw err;
  }

  // Explicit download authorization policy check
  if (!track.download_allowed) {
    const err = new Error('Downloads are not permitted for this track');
    err.status = 403;
    throw err;
  }

  if (!track.audio_key) {
    const err = new Error('Audio file not found for track');
    err.status = 404;
    throw err;
  }

  // Namespace protection: never access users/
  if (track.audio_key.startsWith('users/')) {
    const err = new Error('Forbidden storage namespace');
    err.status = 403;
    throw err;
  }

  return track;
}

module.exports = {
  computeTrackCapabilities,
  formatUniversalTrack,
  searchCatalog,
  browseCatalog,
  getCatalogTrack,
  getCatalogTrackForStream,
  getCatalogTrackForDownload
};
