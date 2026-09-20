const BaseAdapter = require('./baseAdapter');
const { pool } = require('../../db');
const { ProviderTrackNotFoundError } = require('../types');

class NoirSyncPublicAdapter extends BaseAdapter {
  constructor() {
    super('noirsync_public');
  }

  _normalizeTrack(row) {
    if (!row) return null;
    return {
      provider: 'noirsync_public',
      providerTrackId: row.provider_track_id || row.id,
      title: row.title,
      artist: row.artist || 'NoirSync Public',
      album: row.album || undefined,
      duration: row.duration ? Number(row.duration) : undefined,
      coverUrl: row.cover_key
        ? (row.cover_key.startsWith('http://') || row.cover_key.startsWith('https://')
            ? row.cover_key
            : `/api/catalog/tracks/${row.id}/cover`)
        : undefined,
      externalUrl: row.external_url || undefined,
      isPlayable: true,
      downloadAllowed: Boolean(row.download_allowed)
    };
  }

  async search(query) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return [];
    }

    const pattern = `%${query.trim()}%`;
    const res = await pool.query(`
      SELECT * FROM tracks
      WHERE user_id IS NULL
        AND provider = 'noirsync_public'
        AND publication_status = 'published'
        AND (title ILIKE $1 OR artist ILIKE $1 OR album ILIKE $1)
      ORDER BY uploaded_at DESC
      LIMIT 20
    `, [pattern]);

    return res.rows.map(row => this._normalizeTrack(row)).filter(Boolean);
  }

  async getTrack(providerTrackId) {
    if (!providerTrackId) {
      throw new ProviderTrackNotFoundError(this.provider, String(providerTrackId));
    }

    const res = await pool.query(`
      SELECT * FROM tracks
      WHERE user_id IS NULL
        AND provider = 'noirsync_public'
        AND publication_status = 'published'
        AND (provider_track_id = $1 OR id = $1)
      LIMIT 1
    `, [providerTrackId]);

    if (res.rows.length === 0) {
      throw new ProviderTrackNotFoundError(this.provider, providerTrackId);
    }

    return this._normalizeTrack(res.rows[0]);
  }
}

module.exports = NoirSyncPublicAdapter;
