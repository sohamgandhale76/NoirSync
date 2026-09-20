const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');

/**
 * Resolves a ProviderTrack into a NoirSync Track ID.
 * Checks for existing canonical record first, then inserts with ON CONFLICT / fallback handling.
 * 
 * @param {import('./types').ProviderTrack} providerTrack
 * @param {import('pg').PoolClient|import('pg').Pool} [client]
 * @returns {Promise<Object>} The NoirSync Track object from DB
 */
async function resolveProviderTrack(providerTrack, client = pool) {
  const provider = providerTrack.provider;
  const providerTrackId = providerTrack.providerTrackId || providerTrack.provider_track_id;

  if (!provider || provider === 'local' || !providerTrackId) {
    throw new Error('Invalid external provider track data: provider and providerTrackId are required');
  }

  // 1. Check if track already exists by (provider, provider_track_id)
  const existing = await client.query(
    'SELECT * FROM tracks WHERE provider = $1 AND provider_track_id = $2 LIMIT 1',
    [provider, providerTrackId]
  );

  if (existing.rows.length > 0) {
    const t = existing.rows[0];
    const updateTitle = providerTrack.title || t.title;
    const updateArtist = providerTrack.artist || t.artist;
    const updateCover = providerTrack.coverUrl || providerTrack.cover_url || t.cover_key;
    const updateAlbum = providerTrack.album || t.album;
    const updateExtUrl = providerTrack.externalUrl || providerTrack.external_url || t.external_url;
    const updateDuration = providerTrack.duration || t.duration;

    if (
      updateTitle !== t.title ||
      updateArtist !== t.artist ||
      updateCover !== t.cover_key ||
      updateAlbum !== t.album ||
      updateExtUrl !== t.external_url ||
      (updateDuration && !t.duration)
    ) {
      const updated = await client.query(`
        UPDATE tracks 
        SET title = $1, artist = $2, cover_key = $3, album = $4, external_url = $5, duration = COALESCE(duration, $6), publication_status = 'published'
        WHERE id = $7
        RETURNING *
      `, [updateTitle, updateArtist, updateCover, updateAlbum, updateExtUrl, updateDuration, t.id]);
      return updated.rows[0] || t;
    }
    return t;
  }

  // 2. Insert new track record
  const id = `ext_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  try {
    const insertRes = await client.query(`
      INSERT INTO tracks (id, title, artist, duration, provider, provider_track_id, cover_key, album, external_url, publication_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published')
      ON CONFLICT (provider, provider_track_id) WHERE provider_track_id IS NOT NULL
      DO UPDATE SET 
        title = COALESCE(tracks.title, EXCLUDED.title),
        artist = COALESCE(tracks.artist, EXCLUDED.artist),
        duration = COALESCE(tracks.duration, EXCLUDED.duration),
        cover_key = COALESCE(tracks.cover_key, EXCLUDED.cover_key),
        album = COALESCE(tracks.album, EXCLUDED.album),
        external_url = COALESCE(tracks.external_url, EXCLUDED.external_url),
        publication_status = 'published'
      RETURNING *
    `, [
      id,
      providerTrack.title || 'Untitled Track',
      providerTrack.artist || 'Unknown Artist',
      providerTrack.duration || null,
      provider,
      providerTrackId,
      providerTrack.coverUrl || providerTrack.cover_url || null,
      providerTrack.album || null,
      providerTrack.externalUrl || providerTrack.external_url || null
    ]);
    return insertRes.rows[0];
  } catch {
    // If ON CONFLICT failed due to index definition differences, check if inserted concurrently
    const retryExisting = await client.query(
      'SELECT * FROM tracks WHERE provider = $1 AND provider_track_id = $2 LIMIT 1',
      [provider, providerTrackId]
    );
    if (retryExisting.rows.length > 0) {
      return retryExisting.rows[0];
    }
    // Fall back to direct insert
    const plainInsert = await client.query(`
      INSERT INTO tracks (id, title, artist, duration, provider, provider_track_id, cover_key, album, external_url, publication_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published')
      RETURNING *
    `, [
      id,
      providerTrack.title || 'Untitled Track',
      providerTrack.artist || 'Unknown Artist',
      providerTrack.duration || null,
      provider,
      providerTrackId,
      providerTrack.coverUrl || providerTrack.cover_url || null,
      providerTrack.album || null,
      providerTrack.externalUrl || providerTrack.external_url || null
    ]);
    return plainInsert.rows[0];
  }
}

module.exports = {
  resolveProviderTrack
};
