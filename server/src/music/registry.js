const SpotifyAdapter = require('./providers/spotify');
const YouTubeAdapter = require('./providers/youtube');
const AppleAdapter = require('./providers/apple');

const providers = {
  spotify: new SpotifyAdapter(),
  youtube: new YouTubeAdapter(),
  apple: new AppleAdapter()
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

module.exports = {
  getMusicProvider,
  getAvailableProviders
};
