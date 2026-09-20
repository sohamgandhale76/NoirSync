// ─── PostgreSQL Database Module ───────────────────────────────────────────────
// Uses the `pg` package to connect to a PostgreSQL database (Render-compatible).
// Exports async CRUD functions for the `tracks` table.

const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres requires SSL in production
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

/**
 * Create the `tracks` table if it doesn't already exist.
 * Called once on server startup before accepting requests.
 */
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tracks (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        artist      TEXT,
        duration    REAL,
        size        INTEGER,
        format      TEXT,
        audio_key   TEXT,
        cover_key   TEXT,
        lyrics_key  TEXT,
        uploaded_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        provider    TEXT DEFAULT 'local',
        provider_track_id TEXT
      )
    `);

    // Idempotent migrations for existing tables
    await pool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'local'`);
    await pool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS provider_track_id TEXT`);
    await pool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS album TEXT`);
    await pool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS external_url TEXT`);
    await pool.query(`ALTER TABLE tracks ALTER COLUMN audio_key DROP NOT NULL`);
    await pool.query(`ALTER TABLE tracks ALTER COLUMN size DROP NOT NULL`);
    await pool.query(`ALTER TABLE tracks ALTER COLUMN format DROP NOT NULL`);
    
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS tracks_provider_provider_track_id_idx 
      ON tracks (provider, provider_track_id) 
      WHERE provider_track_id IS NOT NULL;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        created_at BIGINT NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS connected_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        access_token_enc TEXT,
        refresh_token_enc TEXT,
        expires_at BIGINT,
        scopes TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(user_id, provider)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS playlists_user_id_idx 
      ON playlists(user_id)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        id TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        added_at BIGINT NOT NULL,
        UNIQUE (playlist_id, track_id)
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS playlist_tracks_playlist_id_position_idx 
      ON playlist_tracks (playlist_id, position)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS playlist_tracks_track_id_idx 
      ON playlist_tracks (track_id)
    `);

    logger.info('PostgreSQL: tables ready');
  } catch (err) {
    logger.error('PostgreSQL: failed to create tables', { error: err.message });
    throw err;
  }
}

/**
 * Insert a new track record.
 * @param {{ id, title, artist, duration, size, format, audio_key, cover_key, lyrics_key, provider, provider_track_id, album, external_url }} track
 */
async function insertTrack(track) {
  const { id, title, artist, duration, size, format, audio_key, cover_key, lyrics_key, provider, provider_track_id, album, external_url } = track;
  const result = await pool.query(
    `INSERT INTO tracks (id, title, artist, duration, size, format, audio_key, cover_key, lyrics_key, provider, provider_track_id, album, external_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [id, title, artist || null, duration || null, size || null, format || null,
     audio_key || null, cover_key || null, lyrics_key || null, provider || 'local', provider_track_id || null, album || null, external_url || null]
  );
  return result.rows[0];
}

/**
 * Retrieve all tracks ordered by upload time descending.
 * @returns {Promise<Array>}
 */
async function getAllTracks() {
  const result = await pool.query(
    'SELECT * FROM tracks ORDER BY uploaded_at DESC'
  );
  return result.rows;
}

/**
 * Retrieve a single track by its ID.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
async function getTrack(id) {
  const result = await pool.query('SELECT * FROM tracks WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/**
 * Delete a track record by ID.
 * @param {string} id
 */
async function deleteTrack(id) {
  await pool.query('DELETE FROM tracks WHERE id = $1', [id]);
}

/**
 * Update the lyrics_key for an existing track.
 * @param {string} id
 * @param {string} lyricsKey
 * @returns {Promise<Object|null>}
 */
async function updateTrackLyricsKey(id, lyricsKey) {
  const result = await pool.query(
    'UPDATE tracks SET lyrics_key = $1 WHERE id = $2 RETURNING *',
    [lyricsKey, id]
  );
  return result.rows[0] || null;
}

module.exports = { pool, initDb, insertTrack, getAllTracks, getTrack, deleteTrack, updateTrackLyricsKey };
