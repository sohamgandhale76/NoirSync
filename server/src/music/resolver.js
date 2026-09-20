const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

/**
 * Resolves a ProviderTrack into a NoirSync Track ID.
 * Uses an atomic UPSERT to prevent race conditions causing duplicates.
 * 
 * @param {import('./types').ProviderTrack} providerTrack
 * @returns {Promise<Object>} The NoirSync Track object from DB
 */
async function resolveProviderTrack(providerTrack) {
  if (providerTrack.provider === 'local') {
    throw new Error('Local tracks cannot be resolved through the external track resolver.');
  }

  const id = `ext_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  
  // UPSERT the track using ON CONFLICT on the partial unique index.
  // PostgreSQL does not allow ON CONFLICT on a partial index without specifying the WHERE clause in the DO UPDATE.
  // However, we can use a CTE or just handle conflict with the unique index explicitly.
  // Wait, `ON CONFLICT (provider, provider_track_id) WHERE provider_track_id IS NOT NULL` is not supported in all older versions,
  // but let's try the standard syntax. 
  // Actually, standard `ON CONFLICT (provider, provider_track_id) WHERE provider_track_id IS NOT NULL` is valid PG syntax.

  const query = `
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
    RETURNING *;
  `;

  const values = [
    id,
    providerTrack.title,
    providerTrack.artist || 'Unknown',
    providerTrack.duration || null,
    providerTrack.provider,
    providerTrack.providerTrackId,
    providerTrack.coverUrl || null,
    providerTrack.album || null,
    providerTrack.externalUrl || providerTrack.external_url || null
  ];

  const result = await pool.query(query, values);
  return result.rows[0];
}

module.exports = {
  resolveProviderTrack
};
