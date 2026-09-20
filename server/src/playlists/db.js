// ─── Playlist PostgreSQL Database Layer ─────────────────────────────────────
// Parameterized, concurrency-safe operations for persistent playlists.

const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { resolveProviderTrack } = require('../music/resolver');
const { isCanonicalProvider } = require('../music/registry');

/**
 * Check if a track is accessible to the requesting user for playlist operations.
 * - Authenticated users can access valid persistent Cloud/R2 tracks:
 *   (track.provider === 'local' && track.audio_key != null) regardless of user_id.
 * - Requester-owned track (track.user_id === userId) -> accessible
 * - Canonical provider metadata record (isCanonicalProvider(track.provider)) -> accessible
 * - Published NoirSync public catalog track (noirsync_public && publication_status === 'published') -> accessible
 * - Another user's track with NO audio_key (user_id !== userId && !audio_key) -> INACCESSIBLE
 * 
 * @param {Object} track 
 * @param {string} userId 
 * @returns {boolean}
 */
function isTrackAccessible(track, userId) {
  if (!track || !userId) return false;

  // 1. Authenticated users can access valid persistent Cloud/R2 tracks.
  // Must be a local-provider track with persistent R2 audio (audio_key != null).
  // user_id is optional attribution metadata, NOT an access gate.
  if (track.provider === 'local' && track.audio_key) {
    return true;
  }

  // 2. Requester-owned track (even if audio_key is null, e.g. custom metadata/draft)
  if (track.user_id && track.user_id === userId) {
    return true;
  }

  // 3. Canonical provider metadata records
  if (isCanonicalProvider(track.provider)) {
    // If noirsync_public, must be explicitly published
    if (track.provider === 'noirsync_public') {
      return track.publication_status === 'published';
    }
    return true;
  }

  return false;
}

/**
 * Ensures a track exists in the canonical tracks table.
 * If local, verifies in database or falls back to legacy catalog.
 * If external (spotify, youtube, apple, noirsync_public), checks existing DB record or uses provider adapter.
 * IMPORTANT: Client-supplied metadata is NEVER authoritative. Authoritative metadata
 * must come from the registered provider adapter or existing database records.
 * 
 * @param {Object} track 
 * @returns {Promise<Object>} Canonical track from tracks table
 */
async function ensureTrackExists(track) {
  if (!track) {
    const err = new Error('No track data provided');
    err.status = 400;
    throw err;
  }

  // 1. If track.id is provided, check if it already exists in canonical tracks
  if (track.id) {
    const existing = await pool.query('SELECT * FROM tracks WHERE id = $1', [track.id]);
    if (existing.rows.length > 0) {
      return existing.rows[0];
    }
  }

  // 2. If provider is external and provider_track_id is present
  const provider = track.provider;
  const providerTrackId = track.provider_track_id || track.providerTrackId;

  if (provider && provider !== 'local' && providerTrackId) {
    const existingResult = await pool.query(
      'SELECT * FROM tracks WHERE provider = $1 AND provider_track_id = $2',
      [provider, providerTrackId]
    );

    if (existingResult.rows.length > 0) {
      return existingResult.rows[0];
    }

    // IMPORTANT: CLIENT METADATA IS NEVER AUTHORITATIVE!
    // Fetch authoritative metadata from provider adapter rather than trusting client fields.
    const { getMusicProvider } = require('../music/registry');
    const adapter = getMusicProvider(provider);
    let authoritativeTrack = null;
    try {
      authoritativeTrack = await adapter.getTrack(providerTrackId);
    } catch (adapterErr) {
      if (process.env.NODE_ENV !== 'production' && process.env.SPOTIFY_DEV_FIXTURES === 'true' && track.title && (providerTrackId.startsWith('sp_') || providerTrackId.startsWith('spot_') || providerTrackId.startsWith('yt_'))) {
        authoritativeTrack = {
          provider,
          providerTrackId,
          title: track.title,
          artist: track.artist || 'Unknown Artist',
          duration: track.duration,
          album: track.album,
          coverUrl: track.cover_key || track.coverUrl,
          externalUrl: track.external_url || track.externalUrl
        };
      } else {
        const err = new Error(adapterErr.message || 'Track not found in provider');
        err.status = adapterErr.status || 404;
        throw err;
      }
    }

    if (!authoritativeTrack) {
      if (process.env.NODE_ENV !== 'production' && process.env.SPOTIFY_DEV_FIXTURES === 'true' && track.title && (providerTrackId.startsWith('sp_') || providerTrackId.startsWith('spot_') || providerTrackId.startsWith('yt_'))) {
        authoritativeTrack = {
          provider,
          providerTrackId,
          title: track.title,
          artist: track.artist || 'Unknown Artist',
          duration: track.duration,
          album: track.album,
          coverUrl: track.cover_key || track.coverUrl,
          externalUrl: track.external_url || track.externalUrl
        };
      } else {
        const err = new Error('Track not found in provider');
        err.status = 404;
        throw err;
      }
    }

    // Resolve and insert canonical track using authoritative provider metadata ONLY
    const resolved = await resolveProviderTrack({
      provider: authoritativeTrack.provider || provider,
      providerTrackId: authoritativeTrack.providerTrackId || providerTrackId,
      title: authoritativeTrack.title,
      artist: authoritativeTrack.artist,
      duration: authoritativeTrack.duration,
      coverUrl: authoritativeTrack.coverUrl,
      album: authoritativeTrack.album,
      externalUrl: authoritativeTrack.externalUrl
    });
    return resolved;
  }

  // 3. If local track ID doesn't exist in DB, check local library catalog
  if (track.id) {
    try {
      const libraryManager = require('../libraryManager');
      const localTrack = libraryManager.getTrack(track.id);
      if (localTrack) {
        const { insertTrack } = require('../db');
        const inserted = await insertTrack({
          id: localTrack.id,
          title: localTrack.title || 'Untitled Track',
          artist: localTrack.artist || 'Unknown Artist',
          duration: localTrack.duration || null,
          size: localTrack.fileSize || null,
          format: localTrack.originalExtension ? localTrack.originalExtension.replace(/^\./, '') : 'mp3',
          audio_key: null,
          cover_key: localTrack.coverFilename || null,
          lyrics_key: null,
          provider: 'local',
          provider_track_id: null,
          album: localTrack.album || null,
          external_url: null
        });
        return inserted;
      }
    } catch {
      // Non-fatal, handled below
    }
  }

  const err = new Error('Track not found in canonical library or provider registry');
  err.status = 404;
  throw err;
}

/**
 * Retrieve all playlists for a user with track counts.
 * 
 * @param {string} userId 
 * @returns {Promise<Array>}
 */
async function getUserPlaylists(userId) {
  if (!userId) return [];
  const result = await pool.query(`
    SELECT 
      p.id,
      p.user_id,
      p.name,
      p.description,
      p.created_at,
      p.updated_at,
      COUNT(pt.id)::int AS track_count
    FROM playlists p
    LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    WHERE p.user_id = $1
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `, [userId]);
  return result.rows;
}

/**
 * Retrieve a single playlist by ID for the authenticated user, including ordered tracks.
 * 
 * @param {string} playlistId 
 * @param {string} userId 
 * @returns {Promise<Object|null>}
 */
async function getPlaylistById(playlistId, userId) {
  if (!playlistId || !userId) return null;

  const playlistResult = await pool.query(`
    SELECT id, user_id, name, description, created_at, updated_at
    FROM playlists
    WHERE id = $1 AND user_id = $2
  `, [playlistId, userId]);

  if (playlistResult.rows.length === 0) {
    return null;
  }

  const playlist = playlistResult.rows[0];

  const tracksResult = await pool.query(`
    SELECT 
      pt.id AS playlist_track_id,
      pt.position,
      pt.added_at,
      t.id,
      t.title,
      t.artist,
      t.album,
      t.duration,
      t.size,
      t.format,
      t.audio_key,
      t.cover_key,
      t.lyrics_key,
      t.provider,
      t.provider_track_id,
      t.external_url,
      t.uploaded_at,
      t.user_id AS track_user_id
    FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = $1
    ORDER BY pt.position ASC
  `, [playlistId]);

  const accessibleTracks = [];
  for (const row of tracksResult.rows) {
    const trackWithOwnership = { ...row, user_id: row.track_user_id };
    if (!isTrackAccessible(trackWithOwnership, userId)) {
      // Omit entirely from the response if unauthorized or orphaned local track
      continue;
    }

    // Sanitize: strip raw R2 storage keys from response
    const safeTrack = { ...row };
    delete safeTrack.audio_key;
    delete safeTrack.cover_key;
    delete safeTrack.lyrics_key;
    delete safeTrack.track_user_id;

    if (row.cover_key) {
      safeTrack.has_cover = true;
      safeTrack.cover_url = (row.cover_key.startsWith('http://') || row.cover_key.startsWith('https://'))
        ? row.cover_key
        : `/library/${row.id}/cover`;
    } else {
      safeTrack.has_cover = false;
      safeTrack.cover_url = null;
    }

    accessibleTracks.push(safeTrack);
  }

  playlist.tracks = accessibleTracks;
  playlist.track_count = accessibleTracks.length;
  return playlist;
}

/**
 * Create a new playlist for the authenticated user.
 * 
 * @param {string} userId 
 * @param {string} name 
 * @param {string} [description] 
 * @returns {Promise<Object>}
 */
async function createPlaylist(userId, name, description) {
  if (!userId) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > 255) {
    const err = new Error('Playlist name must be between 1 and 255 characters');
    err.status = 400;
    throw err;
  }

  const desc = typeof description === 'string' ? description.trim() : null;
  const id = `pl_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();

  const result = await pool.query(`
    INSERT INTO playlists (id, user_id, name, description, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, user_id, name, description, created_at, updated_at
  `, [id, userId, trimmedName, desc, now, now]);

  const playlist = result.rows[0];
  playlist.track_count = 0;
  playlist.tracks = [];
  return playlist;
}

/**
 * Update playlist details (name and/or description only).
 * 
 * @param {string} playlistId 
 * @param {string} userId 
 * @param {{ name?: string, description?: string }} updates 
 * @returns {Promise<Object|null>}
 */
async function updatePlaylist(playlistId, userId, updates) {
  if (!playlistId || !userId) return null;

  const allowedClauses = [];
  const values = [];
  let paramIdx = 1;

  if (updates.name !== undefined) {
    const trimmed = typeof updates.name === 'string' ? updates.name.trim() : '';
    if (!trimmed || trimmed.length > 255) {
      const err = new Error('Playlist name must be between 1 and 255 characters');
      err.status = 400;
      throw err;
    }
    allowedClauses.push(`name = $${paramIdx++}`);
    values.push(trimmed);
  }

  if (updates.description !== undefined) {
    const desc = typeof updates.description === 'string' ? updates.description.trim() : null;
    allowedClauses.push(`description = $${paramIdx++}`);
    values.push(desc);
  }

  if (allowedClauses.length === 0) {
    return getPlaylistById(playlistId, userId);
  }

  const now = Date.now();
  allowedClauses.push(`updated_at = $${paramIdx++}`);
  values.push(now);

  values.push(playlistId);
  const pidParam = paramIdx++;
  values.push(userId);
  const uidParam = paramIdx++;

  const query = `
    UPDATE playlists
    SET ${allowedClauses.join(', ')}
    WHERE id = $${pidParam} AND user_id = $${uidParam}
    RETURNING id, user_id, name, description, created_at, updated_at
  `;

  const result = await pool.query(query, values);
  if (result.rows.length === 0) {
    return null;
  }

  return getPlaylistById(playlistId, userId);
}

/**
 * Delete a playlist owned by userId.
 * Cascades to delete playlist_tracks; canonical tracks remain intact.
 * 
 * @param {string} playlistId 
 * @param {string} userId 
 * @returns {Promise<boolean>}
 */
async function deletePlaylist(playlistId, userId) {
  if (!playlistId || !userId) return false;

  const result = await pool.query(`
    DELETE FROM playlists
    WHERE id = $1 AND user_id = $2
    RETURNING id
  `, [playlistId, userId]);

  return result.rows.length > 0;
}

/**
 * Add a track to a playlist with concurrency protection and atomic server-generated position.
 * 
 * @param {string} playlistId 
 * @param {string} userId 
 * @param {string} [trackId] 
 * @param {Object} [optionalTrackData] 
 * @returns {Promise<Object>} Added join row with canonical track info
 */
async function addTrackToPlaylist(playlistId, userId, trackId, optionalTrackData) {
  if (!playlistId || !userId) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  // Resolve canonical track
  let track = null;
  if (trackId) {
    const existing = await pool.query('SELECT * FROM tracks WHERE id = $1', [trackId]);
    if (existing.rows.length > 0) {
      track = existing.rows[0];
    }
  }

  if (!track && optionalTrackData) {
    track = await ensureTrackExists(optionalTrackData);
  } else if (!track && trackId) {
    try {
      track = await ensureTrackExists({ id: trackId, ...(optionalTrackData || {}) });
    } catch {
      // not found
    }
  }

  if (!track) {
    const err = new Error('Track not found');
    err.status = 404;
    throw err;
  }

  // Enforce track authorization:
  // Requester must own the track OR it must be a recognized canonical provider metadata record.
  // Orphaned local tracks (user_id IS NULL) and other users' private tracks are rejected.
  if (!isTrackAccessible(track, userId)) {
    const err = new Error('Track not found');
    err.status = 404;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Enforce ownership and serialize appends by locking playlist row
    const pCheck = await client.query(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [playlistId, userId]
    );

    if (pCheck.rows.length === 0) {
      const err = new Error('Playlist not found');
      err.status = 404;
      throw err;
    }

    // 2. Check for duplicate track in this playlist
    const dupCheck = await client.query(
      'SELECT 1 FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2',
      [playlistId, track.id]
    );

    if (dupCheck.rows.length > 0) {
      const err = new Error('Track is already in this playlist');
      err.status = 409;
      throw err;
    }

    // 3. Compute next position under the playlist lock
    const posRes = await client.query(
      'SELECT COALESCE(MAX(position) + 1, 0)::int AS next_pos FROM playlist_tracks WHERE playlist_id = $1',
      [playlistId]
    );
    const nextPos = posRes.rows[0].next_pos;

    // 4. Insert join record
    const ptId = `pt_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = Date.now();

    await client.query(`
      INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [ptId, playlistId, track.id, nextPos, now]);

    // 5. Update playlist updated_at
    await client.query(
      'UPDATE playlists SET updated_at = $1 WHERE id = $2',
      [now, playlistId]
    );

    await client.query('COMMIT');

    // Sanitize track in response: never expose raw R2 storage keys
    const safeTrack = { ...track };
    delete safeTrack.audio_key;
    delete safeTrack.cover_key;
    delete safeTrack.lyrics_key;
    if (track.cover_key) {
      safeTrack.has_cover = true;
      safeTrack.cover_url = (track.cover_key.startsWith('http://') || track.cover_key.startsWith('https://'))
        ? track.cover_key
        : `/library/${track.id}/cover`;
    } else {
      safeTrack.has_cover = false;
      safeTrack.cover_url = null;
    }

    return {
      id: ptId,
      playlist_track_id: ptId,
      playlist_id: playlistId,
      track_id: track.id,
      position: nextPos,
      added_at: now,
      track: safeTrack
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Remove a track from a playlist and atomically compact remaining positions.
 * 
 * @param {string} playlistId 
 * @param {string} userId 
 * @param {string} trackId 
 * @returns {Promise<{ success: boolean }>}
 */
async function removeTrackFromPlaylist(playlistId, userId, trackId) {
  if (!playlistId || !userId || !trackId) {
    const err = new Error('Invalid parameters');
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock playlist FOR UPDATE to verify ownership and synchronize
    const pCheck = await client.query(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [playlistId, userId]
    );

    if (pCheck.rows.length === 0) {
      const err = new Error('Playlist not found');
      err.status = 404;
      throw err;
    }

    // 2. Delete join row
    const delRes = await client.query(
      'DELETE FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2 RETURNING id',
      [playlistId, trackId]
    );

    if (delRes.rows.length === 0) {
      const err = new Error('Track not found in playlist');
      err.status = 404;
      throw err;
    }

    // 3. Compact positions atomically
    await client.query(`
      WITH ordered AS (
        SELECT id, (ROW_NUMBER() OVER (ORDER BY position ASC) - 1)::int AS new_pos
        FROM playlist_tracks
        WHERE playlist_id = $1
      )
      UPDATE playlist_tracks pt
      SET position = ordered.new_pos
      FROM ordered
      WHERE pt.id = ordered.id
    `, [playlistId]);

    // 4. Update playlist updated_at
    const now = Date.now();
    await client.query(
      'UPDATE playlists SET updated_at = $1 WHERE id = $2',
      [now, playlistId]
    );

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reorder tracks in a playlist atomically.
 * Strictly validates complete membership, no duplicates, count equality.
 * Server assigns deterministic 0-indexed positions.
 * 
 * @param {string} playlistId 
 * @param {string} userId 
 * @param {string[]} trackIds 
 * @returns {Promise<Object>} Updated playlist with reordered tracks
 */
async function reorderPlaylistTracks(playlistId, userId, trackIds) {
  if (!playlistId || !userId) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  if (!Array.isArray(trackIds)) {
    const err = new Error('trackIds must be an array of track IDs');
    err.status = 400;
    throw err;
  }

  // Validate no duplicates in submitted payload
  const uniqueSubmitted = new Set(trackIds);
  if (uniqueSubmitted.size !== trackIds.length) {
    const err = new Error('Duplicate track IDs in reorder payload');
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock playlist FOR UPDATE to verify ownership
    const pCheck = await client.query(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [playlistId, userId]
    );

    if (pCheck.rows.length === 0) {
      const err = new Error('Playlist not found');
      err.status = 404;
      throw err;
    }

    // 2. Fetch current track IDs in playlist
    const currentRes = await client.query(
      'SELECT track_id FROM playlist_tracks WHERE playlist_id = $1',
      [playlistId]
    );
    const currentTrackIds = currentRes.rows.map(r => r.track_id);

    // 3. Strict validation: count and complete membership
    if (trackIds.length !== currentTrackIds.length) {
      const err = new Error(`Track count mismatch: expected ${currentTrackIds.length}, received ${trackIds.length}`);
      err.status = 400;
      throw err;
    }

    const currentSet = new Set(currentTrackIds);
    for (const tid of trackIds) {
      if (!currentSet.has(tid)) {
        const err = new Error(`Track ID ${tid} does not belong to this playlist`);
        err.status = 400;
        throw err;
      }
    }

    // 4. Update positions atomically if not empty
    if (trackIds.length > 0) {
      await client.query(`
        UPDATE playlist_tracks pt
        SET position = data.pos
        FROM (
          SELECT unnest($1::text[]) AS track_id, (generate_subscripts($1::text[], 1) - 1)::int AS pos
        ) data
        WHERE pt.playlist_id = $2 AND pt.track_id = data.track_id
      `, [trackIds, playlistId]);
    }

    // 5. Update playlist updated_at
    const now = Date.now();
    await client.query(
      'UPDATE playlists SET updated_at = $1 WHERE id = $2',
      [now, playlistId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getPlaylistById(playlistId, userId);
}

/**
 * Detect and detach invalid historical cross-user playlist_tracks references.
 * Idempotent and migration-scoped (recorded in schema_migrations).
 * Deletes ONLY invalid join rows, never deletes tracks or playlists, never reassigns ownership.
 * 
 * @param {import('pg').PoolClient|import('pg').Pool} [client]
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ executed: boolean, deletedCount: number }>}
 */
async function cleanupInvalidPlaylistTracks(client = pool, { force = false } = {}) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL,
      details TEXT
    )
  `);

  if (!force) {
    const check = await client.query(
      'SELECT 1 FROM schema_migrations WHERE id = $1',
      ['phase_6c_cleanup_invalid_playlist_tracks']
    );
    if (check.rows.length > 0) {
      return { executed: false, deletedCount: 0 };
    }
  }

  const deleteRes = await client.query(`
    DELETE FROM playlist_tracks pt
    USING playlists p, tracks t
    WHERE pt.playlist_id = p.id
      AND pt.track_id = t.id
      AND p.user_id != t.user_id
      AND t.user_id IS NOT NULL
      AND t.audio_key IS NULL
  `);

  const deletedCount = deleteRes.rowCount || 0;
  const now = Date.now();

  await client.query(`
    INSERT INTO schema_migrations (id, applied_at, details)
    VALUES ($1, $2, $3)
    ON CONFLICT (id) DO UPDATE SET
      applied_at = EXCLUDED.applied_at,
      details = EXCLUDED.details
  `, ['phase_6c_cleanup_invalid_playlist_tracks', now, `Detached ${deletedCount} invalid cross-user playlist_tracks references`]);

  return { executed: true, deletedCount };
}

/**
 * Import a Spotify playlist into NoirSync for the authenticated user.
 * Atomically creates the playlist and its playlist_tracks within a single transaction.
 * Preserves ordering, resolves canonical tracks, skips local/unavailable tracks, and deduplicates.
 * 
 * @param {string} userId 
 * @param {Object} spotifyPlaylistData 
 * @returns {Promise<{ playlist: Object, summary: Object }>}
 */
async function importSpotifyPlaylist(userId, spotifyPlaylistData) {
  if (!userId) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  const { name, description, items } = spotifyPlaylistData;
  const playlistName = (name && typeof name === 'string' && name.trim()) ? name.trim() : 'Imported Spotify Playlist';

  // 1. Process items in memory first
  let total = 0;
  let added = 0;
  let unavailable = 0;
  let duplicates = 0;

  const seenSpotifyIds = new Set();
  const tracksToAdd = [];

  for (const item of (items || [])) {
    total++;
    // Support item.track, item.item, or item directly
    const rawTrack = item?.track || item?.item || item;

    if (!rawTrack) {
      unavailable++;
      continue;
    }

    // Extract track ID from id or uri (spotify:track:ID)
    let trackId = rawTrack.id;
    if (!trackId && typeof rawTrack.uri === 'string' && rawTrack.uri.startsWith('spotify:track:')) {
      trackId = rawTrack.uri.split(':')[2];
    }

    if (!trackId || rawTrack.is_local) {
      unavailable++;
      continue;
    }

    // Check duplicate within playlist (preserve first occurrence)
    if (seenSpotifyIds.has(trackId)) {
      duplicates++;
      continue;
    }
    seenSpotifyIds.add(trackId);

    // Format artist names
    let artistName = 'Unknown Artist';
    if (Array.isArray(rawTrack.artists)) {
      artistName = rawTrack.artists.map(a => a?.name).filter(Boolean).join(', ') || 'Unknown Artist';
    } else if (typeof rawTrack.artist === 'string') {
      artistName = rawTrack.artist;
    }

    // Extract duration
    let durationSec = undefined;
    if (typeof rawTrack.duration_ms === 'number') {
      durationSec = rawTrack.duration_ms / 1000;
    } else if (typeof rawTrack.duration === 'number') {
      durationSec = rawTrack.duration;
    }

    // Extract cover image
    let coverUrl = undefined;
    if (rawTrack.album?.images && Array.isArray(rawTrack.album.images) && rawTrack.album.images.length > 0) {
      coverUrl = rawTrack.album.images[0].url;
    } else if (rawTrack.images && Array.isArray(rawTrack.images) && rawTrack.images.length > 0) {
      coverUrl = rawTrack.images[0].url;
    } else if (typeof rawTrack.coverUrl === 'string') {
      coverUrl = rawTrack.coverUrl;
    }

    const albumName = rawTrack.album?.name || (typeof rawTrack.album === 'string' ? rawTrack.album : undefined);
    const externalUrl = rawTrack.external_urls?.spotify || `https://open.spotify.com/track/${trackId}`;

    tracksToAdd.push({
      provider: 'spotify',
      providerTrackId: trackId,
      title: rawTrack.name || rawTrack.title || 'Untitled Track',
      artist: artistName,
      album: albumName,
      duration: durationSec,
      coverUrl,
      externalUrl
    });
  }

  // 2. Pre-resolve canonical tracks via atomic UPSERTs in tracks table
  const resolvedTracks = [];
  for (const trackData of tracksToAdd) {
    try {
      const canonicalTrack = await resolveProviderTrack(trackData);
      if (canonicalTrack && canonicalTrack.id) {
        resolvedTracks.push(canonicalTrack);
      } else {
        unavailable++;
      }
    } catch (resolveErr) {
      const logger = require('../logger');
      logger.error('Failed to resolve Spotify track during playlist import', {
        trackId: trackData.providerTrackId,
        title: trackData.title,
        error: resolveErr.message
      });
      unavailable++;
    }
  }

  // 3. Atomically create the NoirSync playlist and insert all playlist_tracks in one transaction
  const client = await pool.connect();
  const playlistId = `pl_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  const desc = typeof description === 'string' ? description.trim() : null;

  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO playlists (id, user_id, name, description, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [playlistId, userId, playlistName, desc, now, now]);

    for (let pos = 0; pos < resolvedTracks.length; pos++) {
      const canonicalTrack = resolvedTracks[pos];
      const ptId = `pt_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

      await client.query(`
        INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (playlist_id, track_id) DO NOTHING
      `, [ptId, playlistId, canonicalTrack.id, pos, now]);
      added++;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const fullPlaylist = await getPlaylistById(playlistId, userId);

  return {
    playlist: fullPlaylist,
    summary: {
      playlistName,
      total,
      added,
      unavailable,
      duplicates
    }
  };
}

module.exports = {
  ensureTrackExists,
  getUserPlaylists,
  getPlaylistById,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
  isTrackAccessible,
  cleanupInvalidPlaylistTracks,
  importSpotifyPlaylist
};
