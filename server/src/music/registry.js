const SpotifyAdapter = require('./providers/spotify');
const YouTubeAdapter = require('./providers/youtube');
const AppleAdapter = require('./providers/apple');
const NoirSyncPublicAdapter = require('./providers/noirsyncPublic');

const providers = {
  spotify: new SpotifyAdapter(),
  youtube: new YouTubeAdapter(),
  apple: new AppleAdapter(),
  noirsync_public: new NoirSyncPublicAdapter()
};

/**
 * Get a music provider adapter by name.
 * @param {'spotify'|'youtube'|'apple'} providerName 
 * @returns {import('./providers/baseAdapter')}
 */
function getMusicProvider(providerName) {
  const adapter = providers[providerName];
  if (!adapter) {
    throw new Error(`Unknown music provider: ${providerName}`);
  }
  return adapter;
}

/**
 * Get all configured/registered providers
 * @returns {string[]}
 */
function getAvailableProviders() {
  return Object.keys(providers);
}

/**
 * Check if a provider name is a recognized canonical provider.
 * @param {string} providerName 
 * @returns {boolean}
 */
function isCanonicalProvider(providerName) {
  if (!providerName || typeof providerName !== 'string') return false;
  return getAvailableProviders().includes(providerName.toLowerCase());
}

module.exports = {
  getMusicProvider,
  getAvailableProviders,
  isCanonicalProvider
};
