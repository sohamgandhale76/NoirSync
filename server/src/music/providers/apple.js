const BaseAdapter = require('./baseAdapter');
const { ProviderNotConfiguredError } = require('../types');

class AppleAdapter extends BaseAdapter {
  constructor() {
    super('apple');
  }

  async search(query) {
    throw new ProviderNotConfiguredError(this.provider);
  }

  async getTrack(providerTrackId) {
    throw new ProviderNotConfiguredError(this.provider);
  }
}

module.exports = AppleAdapter;
