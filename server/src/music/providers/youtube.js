const BaseAdapter = require('./baseAdapter');
const { ProviderNotConfiguredError } = require('../types');

class YouTubeAdapter extends BaseAdapter {
  constructor() {
    super('youtube');
  }

  async search(query) {
    throw new ProviderNotConfiguredError(this.provider);
  }

  async getTrack(providerTrackId) {
    if (process.env.NODE_ENV !== 'production' && providerTrackId && providerTrackId.startsWith('yt_')) {
      return {
        provider: 'youtube',
        providerTrackId,
        title: 'Resonance',
        artist: 'HOME',
        album: 'Odyssey',
        duration: 212,
        coverUrl: `https://i.ytimg.com/vi/${providerTrackId.replace(/^yt_/, '')}/hqdefault.jpg`,
        externalUrl: `https://www.youtube.com/watch?v=${providerTrackId}`,
        isPlayable: true
      };
    }
    throw new ProviderNotConfiguredError(this.provider);
  }
}

module.exports = YouTubeAdapter;
