/**
 * @typedef {'local' | 'spotify' | 'youtube' | 'apple'} MusicProvider
 */

/**
 * @typedef {Object} ProviderTrack
 * @property {MusicProvider} provider - The music provider.
 * @property {string} providerTrackId - The unique ID assigned by the provider.
 * @property {string} title - The song title.
 * @property {string} artist - The primary artist name.
 * @property {string} [album] - The album name.
 * @property {number} [duration] - Duration in seconds.
 * @property {string} [coverUrl] - The URL to the track's cover image.
 * @property {string} [externalUrl] - A URL to view the track on the provider's platform.
 */

class ProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderError';
  }
}

class ProviderNotConfiguredError extends ProviderError {
  constructor(provider) {
    super(`Provider ${provider} is not configured.`);
    this.name = 'ProviderNotConfiguredError';
  }
}

class ProviderUnavailableError extends ProviderError {
  constructor(provider, message) {
    super(`Provider ${provider} is currently unavailable: ${message}`);
    this.name = 'ProviderUnavailableError';
  }
}

class ProviderTrackNotFoundError extends ProviderError {
  constructor(provider, trackId) {
    super(`Track ${trackId} not found on provider ${provider}.`);
    this.name = 'ProviderTrackNotFoundError';
  }
}

class ProviderUnsupportedOperationError extends ProviderError {
  constructor(provider, operation) {
    super(`Operation '${operation}' is not supported by provider ${provider}.`);
    this.name = 'ProviderUnsupportedOperationError';
  }
}

module.exports = {
  ProviderError,
  ProviderNotConfiguredError,
  ProviderUnavailableError,
  ProviderTrackNotFoundError,
  ProviderUnsupportedOperationError
};
