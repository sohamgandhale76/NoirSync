const express = require('express');
const { getMusicProvider, getAvailableProviders } = require('./registry');
const { ProviderError } = require('./types');
const logger = require('../logger');

const router = express.Router();

/**
 * Handle a search for a single provider and format the result
 * @param {string} providerName 
 * @param {string} query 
 * @returns {Promise<Object>}
 */
async function searchSingleProvider(providerName, query) {
  try {
    const provider = getMusicProvider(providerName);
    const results = await provider.search(query);
    return {
      provider: providerName,
      status: 'available',
      results
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      return {
        provider: providerName,
        status: 'unavailable',
        error: err.message,
        results: []
      };
    }
    
    logger.error(`Unexpected error in provider ${providerName}`, { error: err.message });
    return {
      provider: providerName,
      status: 'error',
      error: 'An unexpected error occurred.',
      results: []
    };
  }
}

// GET /api/music/search
router.get('/search', async (req, res) => {
  const { q, provider } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query parameter "q" is required.' });
  }

  try {
    const providersToSearch = provider 
      ? [provider]
      : getAvailableProviders();

    const searchPromises = providersToSearch.map(p => searchSingleProvider(p, q));
    const results = await Promise.all(searchPromises);

    res.json({
      query: q,
      providers: results
    });
  } catch (err) {
    logger.error('Error in /api/music/search', { error: err.message });
    res.status(500).json({ error: 'Internal server error during search' });
  }
});

module.exports = router;
