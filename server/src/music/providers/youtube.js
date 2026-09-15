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
    throw new ProviderNotConfiguredError(this.provider);
  }
}

module.exports = YouTubeAdapter;
