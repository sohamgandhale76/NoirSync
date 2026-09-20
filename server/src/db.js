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

    // Phase 6B: User-owned Cloud Library (must come after users table creation)
    await pool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS tracks_user_id_idx ON tracks (user_id)`);

    // Idempotent migrations for users table (Phase 6A)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN DEFAULT true`);

    // Normalize existing guest users (Phase 6A requirement: is_guest NULL -> true)
    await pool.query(`UPDATE users SET is_guest = true WHERE is_guest IS NULL`);
    await pool.query(`ALTER TABLE users ALTER COLUMN is_guest SET NOT NULL`);
    await pool.query(`ALTER TABLE users ALTER COLUMN is_guest SET DEFAULT true`);

    // Authoritative unique constraints for email and username (case-insensitive for permanent users)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx 
      ON users (LOWER(email)) 
      WHERE email IS NOT NULL
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_idx 
      ON users (LOWER(username)) 
      WHERE username IS NOT NULL
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

    // Idempotent migrations for connected_accounts
    await pool.query(`ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS display_name TEXT`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_provider_provider_account_id_idx
      ON connected_accounts (provider, provider_account_id)
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

    // Phase 6C: Idempotent one-time cleanup of invalid historical cross-user playlist_tracks references
    const { cleanupInvalidPlaylistTracks } = require('./playlists/db');
    await cleanupInvalidPlaylistTracks(pool);

    // Phase 6E: Universal Music Library schema additions
    await pool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS publication_status TEXT DEFAULT 'draft'`);
    await pool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS download_allowed BOOLEAN DEFAULT FALSE`);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS tracks_catalog_lookup_idx 
      ON tracks (provider, publication_status) 
      WHERE user_id IS NULL;
    `);

    // Phase 6E: Safe, idempotent migration of legitimate canonical provider records
    // Invariants:
    // - tracks.user_id IS NOT NULL -> remains private, never catalog
    // - provider = 'local' -> remains draft / excluded
    // - Only legitimate canonical provider metadata records (user_id IS NULL, recognized provider, valid ID and title)
    await pool.query(`
      UPDATE tracks
      SET publication_status = 'published'
      WHERE user_id IS NULL
        AND provider IN ('spotify', 'youtube', 'apple')
        AND provider_track_id IS NOT NULL
        AND TRIM(provider_track_id) != ''
        AND id LIKE 'ext_%'
        AND title IS NOT NULL
        AND (publication_status IS NULL OR publication_status = 'draft');
    `);

    logger.info('PostgreSQL: tables ready');
  } catch (err) {
    logger.error('PostgreSQL: failed to create tables', { error: err.message });
    throw err;
  }
}

/**
 * Insert a new track record.
 * @param {{ id, title, artist, duration, size, format, audio_key, cover_key, lyrics_key, provider, provider_track_id, album, external_url, user_id, publication_status, download_allowed }} track
 * @param {import('pg').PoolClient|import('pg').Pool} [client]
 */
async function insertTrack(track, client = pool) {
  const { id, title, artist, duration, size, format, audio_key, cover_key, lyrics_key, provider, provider_track_id, album, external_url, user_id, publication_status, download_allowed } = track;
  const result = await client.query(
    `INSERT INTO tracks (id, title, artist, duration, size, format, audio_key, cover_key, lyrics_key, provider, provider_track_id, album, external_url, user_id, publication_status, download_allowed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [id, title, artist || null, duration || null, size || null, format || null,
     audio_key || null, cover_key || null, lyrics_key || null, provider || 'local', provider_track_id || null, album || null, external_url || null, user_id || null, publication_status || 'draft', Boolean(download_allowed)]
  );
  return result.rows[0];
}

/**
 * Retrieve all shared Cloud/R2 tracks.
 * Invariants:
 * - audio_key IS NOT NULL (strictly persistent R2 audio, not catalog metadata-only tracks)
 * - provider = 'local' (strictly Cloud Library audio, not external provider records)
 * - user_id is optional attribution metadata, NOT an access gate
 * - Ordered by uploaded_at descending
 * @returns {Promise<Array>}
 */
async function getSharedCloudTracks() {
  const result = await pool.query(
    "SELECT * FROM tracks WHERE audio_key IS NOT NULL AND provider = 'local' ORDER BY uploaded_at DESC"
  );
  return result.rows;
}

/**
 * Retrieve all tracks owned by a specific user, ordered by upload time descending.
 * @param {string} userId
 * @returns {Promise<Array>}
 */
async function getAllTracks(userId) {
  if (!userId) return [];
  const result = await pool.query(
    'SELECT * FROM tracks WHERE user_id = $1 ORDER BY uploaded_at DESC',
    [userId]
  );
  return result.rows;
}

/**
 * Retrieve a single track by its ID, with optional ownership enforcement.
 * @param {string} id
 * @param {string} [userId]
 * @returns {Promise<Object|null>}
 */
async function getTrack(id, userId) {
  if (userId) {
    const result = await pool.query('SELECT * FROM tracks WHERE id = $1 AND user_id = $2', [id, userId]);
    return result.rows[0] || null;
  }
  const result = await pool.query('SELECT * FROM tracks WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/**
 * Delete a track record by ID with ownership verification.
 * @param {string} id
 * @param {string} [userId]
 * @returns {Promise<Object|null>} Deleted row or null
 */
async function deleteTrack(id, userId) {
  if (userId) {
    const result = await pool.query('DELETE FROM tracks WHERE id = $1 AND user_id = $2 RETURNING *', [id, userId]);
    return result.rows[0] || null;
  }
  const result = await pool.query('DELETE FROM tracks WHERE id = $1 RETURNING *', [id]);
  return result.rows[0] || null;
}

/**
 * Update the lyrics_key for an existing track with ownership verification.
 * @param {string} id
 * @param {string} lyricsKey
 * @param {string} [userId]
 * @returns {Promise<Object|null>}
 */
async function updateTrackLyricsKey(id, lyricsKey, userId) {
  if (userId) {
    const result = await pool.query(
      'UPDATE tracks SET lyrics_key = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [lyricsKey, id, userId]
    );
    return result.rows[0] || null;
  }
  const result = await pool.query(
    'UPDATE tracks SET lyrics_key = $1 WHERE id = $2 RETURNING *',
    [lyricsKey, id]
  );
  return result.rows[0] || null;
}

/**
 * Get total storage usage in bytes for a specific user.
 * Sums only actual audio files owned by the user (audio_key IS NOT NULL).
 * @param {string} userId
 * @param {import('pg').PoolClient|import('pg').Pool} [client]
 * @returns {Promise<number>}
 */
async function getUserStorageUsage(userId, client = pool) {
  if (!userId) return 0;
  const result = await client.query(
    `SELECT COALESCE(SUM(size), 0)::bigint AS used_bytes 
     FROM tracks 
     WHERE user_id = $1 AND audio_key IS NOT NULL`,
    [userId]
  );
  return Number(result.rows[0].used_bytes);
}

/**
 * Concurrency-safe helper that locks on a user's advisory transaction lock,
 * runs callback, and commits/rollbacks automatically.
 * @param {string} userId
 * @param {function(import('pg').PoolClient): Promise<any>} callback
 * @returns {Promise<any>}
 */
async function withUserLock(userId, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user_quota_${userId}`]);
    const res = await callback(client);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Sanitize a user record for public/client consumption.
 * Guarantees password_hash and internal secrets are NEVER returned.
 * @param {Object} user 
 * @returns {Object|null}
 */
function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email || null,
    username: user.username || null,
    displayName: user.display_name || user.username || null,
    avatarUrl: user.avatar_url || null,
    isGuest: Boolean(user.is_guest),
    createdAt: user.created_at ? Number(user.created_at) : null,
    updatedAt: user.updated_at ? Number(user.updated_at) : null,
  };
}

/**
 * Retrieve user by ID.
 * @param {string} id 
 * @returns {Promise<Object|null>}
 */
async function getUserById(id) {
  if (!id) return null;
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/**
 * Retrieve a permanent user by email or username (case-insensitive).
 * Strictly filters for is_guest = false.
 * @param {string} identifier 
 * @returns {Promise<Object|null>}
 */
async function getUserByIdentifier(identifier) {
  if (!identifier) return null;
  const trimmed = identifier.trim();
  const result = await pool.query(
    `SELECT * FROM users 
     WHERE (LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1))
       AND is_guest = false`,
    [trimmed]
  );
  return result.rows[0] || null;
}

/**
 * Upgrade an existing guest user to a permanent account in-place.
 * Preserves user.id so all associated playlists and connected accounts remain attached.
 * @param {string} id 
 * @param {{ email: string, username: string, displayName?: string, passwordHash: string }} data 
 * @returns {Promise<Object>}
 */
async function upgradeGuestUser(id, { email, username, displayName, passwordHash }) {
  const now = Date.now();
  const normEmail = email.trim().toLowerCase();
  const normUsername = username.trim();
  const normDisplayName = (displayName && displayName.trim()) || normUsername;

  const result = await pool.query(
    `UPDATE users
     SET email = $1,
         username = $2,
         display_name = $3,
         password_hash = $4,
         updated_at = $5,
         is_guest = false
     WHERE id = $6
     RETURNING *`,
    [normEmail, normUsername, normDisplayName, passwordHash, now, id]
  );
  return result.rows[0] || null;
}

/**
 * Create a new user record.
 * @param {{ id: string, email?: string, username?: string, displayName?: string, passwordHash?: string, isGuest?: boolean }} data 
 * @returns {Promise<Object>}
 */
async function createUser({ id, email, username, displayName, passwordHash, isGuest = false }) {
  const now = Date.now();
  const normEmail = email ? email.trim().toLowerCase() : null;
  const normUsername = username ? username.trim() : null;
  const normDisplayName = displayName ? displayName.trim() : (normUsername || null);

  const result = await pool.query(
    `INSERT INTO users (id, email, username, display_name, password_hash, created_at, updated_at, is_guest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [id, normEmail, normUsername, normDisplayName, passwordHash || null, now, now, isGuest]
  );
  return result.rows[0];
}

/**
 * Update an authenticated permanent user's profile.
 * @param {string} id 
 * @param {{ displayName?: string, username?: string, avatarUrl?: string }} updates 
 * @returns {Promise<Object|null>}
 */
async function updateUserProfile(id, updates) {
  if (!id || !updates) return null;

  const allowedClauses = [];
  const values = [];
  let paramIdx = 1;

  if (updates.displayName !== undefined) {
    allowedClauses.push(`display_name = $${paramIdx++}`);
    values.push(updates.displayName ? updates.displayName.trim() : null);
  }
  if (updates.username !== undefined) {
    allowedClauses.push(`username = $${paramIdx++}`);
    values.push(updates.username.trim());
  }
  if (updates.avatarUrl !== undefined) {
    allowedClauses.push(`avatar_url = $${paramIdx++}`);
    values.push(updates.avatarUrl ? updates.avatarUrl.trim() : null);
  }

  if (allowedClauses.length === 0) {
    return getUserById(id);
  }

  const now = Date.now();
  allowedClauses.push(`updated_at = $${paramIdx++}`);
  values.push(now);

  values.push(id);
  const idParam = paramIdx++;

  const query = `
    UPDATE users
    SET ${allowedClauses.join(', ')}
    WHERE id = $${idParam} AND is_guest = false
    RETURNING *
  `;

  const result = await pool.query(query, values);
  return result.rows[0] || null;
}

module.exports = {
  pool,
  initDb,
  insertTrack,
  getAllTracks,
  getSharedCloudTracks,
  getTrack,
  deleteTrack,
  updateTrackLyricsKey,
  sanitizeUser,
  getUserById,
  getUserByIdentifier,
  upgradeGuestUser,
  createUser,
  updateUserProfile,
  getUserStorageUsage,
  withUserLock,
  cleanupInvalidPlaylistTracks: (...args) => require('./playlists/db').cleanupInvalidPlaylistTracks(...args),
};

