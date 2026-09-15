const { ProviderUnsupportedOperationError } = require('../types');

/**
 * Base adapter class that all music providers must inherit from.
 */
class BaseAdapter {
  constructor(providerName) {
    this.provider = providerName;
  }

  /**
   * Search the provider for a query.
   * @param {string} query
   * @returns {Promise<Array<import('../types').ProviderTrack>>}
   */
  async search(query) {
    throw new ProviderUnsupportedOperationError(this.provider, 'search');
  }

  /**
   * Fetch a single track by its provider track ID.
   * @param {string} providerTrackId
   * @returns {Promise<import('../types').ProviderTrack|null>}
   */
  async getTrack(providerTrackId) {
    throw new ProviderUnsupportedOperationError(this.provider, 'getTrack');
  }
}

module.exports = BaseAdapter;
