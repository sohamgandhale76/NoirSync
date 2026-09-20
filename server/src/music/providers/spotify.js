const BaseAdapter = require('./baseAdapter');
const { getSpotifyClientCredentialsToken } = require('./credentials');
const {
  ProviderError,
  ProviderNotConfiguredError,
  ProviderUnavailableError,
  ProviderTrackNotFoundError
} = require('../types');
const {
  isDevFixturesEnabled,
  searchDevFixtures,
  getDevFixtureTrack
} = require('./fixtures');
const logger = require('../../logger');

class SpotifyAdapter extends BaseAdapter {
  constructor() {
    super('spotify');
  }

  async _fetch(endpoint, options = {}) {
    const token = await getSpotifyClientCredentialsToken();
    
    const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!res.ok) {
      const status = res.status;
      if (status === 401) throw new ProviderUnavailableError(this.provider, 'Spotify authentication failed. Please check credentials.');
      if (status === 403) throw new ProviderUnavailableError(this.provider, 'Spotify Development Mode requires a Premium account or whitelisted user.');
      if (status === 404) throw new ProviderTrackNotFoundError(this.provider, endpoint);
      if (status === 429) throw new ProviderUnavailableError(this.provider, 'Spotify rate limit exceeded.');
      throw new ProviderUnavailableError(this.provider, `HTTP ${status}`);
    }

    return await res.json();
  }

  _normalizeTrack(track) {
    if (!track) return null;
    return {
      provider: this.provider,
      providerTrackId: track.id,
      title: track.name,
      artist: track.artists ? track.artists.map(a => a.name).join(', ') : 'Unknown Artist',
      album: track.album ? track.album.name : undefined,
      duration: track.duration_ms ? track.duration_ms / 1000 : undefined,
      coverUrl: (track.album && track.album.images && track.album.images.length > 0) ? track.album.images[0].url : undefined,
      externalUrl: (track.external_urls && track.external_urls.spotify) ? track.external_urls.spotify : undefined,
      isPlayable: false // Explicitly set to false as per Phase 3 requirements
    };
  }

  async search(query) {
    if (isDevFixturesEnabled()) {
      return searchDevFixtures(query);
    }

    try {
      const params = new URLSearchParams({
        q: query,
        type: 'track',
        limit: 10
      });

      const data = await this._fetch(`/search?${params.toString()}`);
      if (!data || !data.tracks || !data.tracks.items) return [];

      return data.tracks.items.map(t => this._normalizeTrack(t)).filter(Boolean);
    } catch (err) {
      if (err.message === 'Spotify API credentials are not configured') {
        throw new ProviderNotConfiguredError(this.provider);
      }
      if (err.message === 'ProviderAuthenticationFailed') {
        throw new ProviderUnavailableError(this.provider, 'Spotify authentication failed. Please check credentials.');
      }
      if (err.message === 'ProviderRateLimited') {
        throw new ProviderUnavailableError(this.provider, 'Spotify rate limit exceeded.');
      }
      if (err instanceof ProviderError) {
        throw err;
      }
      logger.error('Spotify API search error', { query, error: err.message });
      throw err;
    }
  }

  async getTrack(providerTrackId) {
    if (isDevFixturesEnabled()) {
      const fixture = getDevFixtureTrack(providerTrackId);
      if (fixture) return fixture;
      throw new ProviderTrackNotFoundError(this.provider, providerTrackId);
    }

    try {
      const track = await this._fetch(`/tracks/${providerTrackId}`);
      return this._normalizeTrack(track);
    } catch (err) {
      if (err.message === 'Spotify API credentials are not configured') {
        throw new ProviderNotConfiguredError(this.provider);
      }
      if (err.message === 'ProviderAuthenticationFailed') {
        throw new ProviderUnavailableError(this.provider, 'Spotify authentication failed. Please check credentials.');
      }
      if (err.message === 'ProviderRateLimited') {
        throw new ProviderUnavailableError(this.provider, 'Spotify rate limit exceeded.');
      }
      if (err instanceof ProviderError) {
        throw err;
      }
      logger.error('Spotify API getTrack error', { providerTrackId, error: err.message });
      throw err;
    }
  }
}

module.exports = SpotifyAdapter;
