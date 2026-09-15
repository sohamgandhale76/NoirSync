const { encrypt, decrypt } = require('../../auth/crypto');
const db = require('../../db');
const logger = require('../../logger');

let clientCredentialsToken = null;
let clientCredentialsExpiresAt = 0;

/**
 * Fetch a Spotify Client Credentials token.
 * We cache it in memory to avoid requesting a new one every time.
 */
async function getSpotifyClientCredentialsToken() {
  const now = Date.now();
  // Refresh if missing or expiring within 60 seconds
  if (clientCredentialsToken && clientCredentialsExpiresAt > now + 60000) {
    return clientCredentialsToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Spotify API credentials are not configured');
  }

  try {
    const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to fetch Spotify client credentials', { status: response.status, body: errorText });
      if (response.status === 429) throw new Error('ProviderRateLimited');
      throw new Error('ProviderAuthenticationFailed');
    }

    const data = await response.json();
    clientCredentialsToken = data.access_token;
    clientCredentialsExpiresAt = now + (data.expires_in * 1000);
    return clientCredentialsToken;
  } catch (err) {
    logger.error('Spotify client credentials error', { error: err.message });
    throw err;
  }
}

/**
 * Get a user's access token for a given provider, refreshing it if necessary.
 */
async function getUserAccessToken(userId, provider) {
  const result = await db.pool.query(
    'SELECT * FROM connected_accounts WHERE user_id = $1 AND provider = $2',
    [userId, provider]
  );
  if (result.rows.length === 0) return null;

  const account = result.rows[0];
  const now = Date.now();

  // If token is valid for more than 60 seconds, use it
  if (account.expires_at > now + 60000) {
    return decrypt(account.access_token_enc);
  }

  // Token is expired or expiring soon, try to refresh
  const refreshToken = decrypt(account.refresh_token_enc);
  if (!refreshToken) {
    throw new Error('ProviderTokenExpired');
  }

  if (provider === 'spotify') {
    return await refreshSpotifyUserToken(userId, account.id, refreshToken);
  }

  throw new Error('Unsupported provider for token refresh');
}

/**
 * Refresh a Spotify user token using their refresh token.
 */
async function refreshSpotifyUserToken(userId, accountId, refreshToken) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authString}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!response.ok) {
    logger.error('Failed to refresh Spotify user token', { status: response.status });
    // Revoke account if refresh token is dead
    if (response.status === 400 || response.status === 401) {
      await db.pool.query('DELETE FROM connected_accounts WHERE id = $1', [accountId]);
      throw new Error('ProviderAuthenticationFailed');
    }
    throw new Error('ProviderUnavailable');
  }

  const data = await response.json();
  const newAccessToken = data.access_token;
  const newRefreshToken = data.refresh_token || refreshToken; // Spotify sometimes doesn't return a new RT
  const expiresAt = Date.now() + (data.expires_in * 1000);

  // Encrypt and persist
  await db.pool.query(
    `UPDATE connected_accounts 
     SET access_token_enc = $1, refresh_token_enc = $2, expires_at = $3, updated_at = $4
     WHERE id = $5`,
    [encrypt(newAccessToken), encrypt(newRefreshToken), expiresAt, Date.now(), accountId]
  );

  return newAccessToken;
}

module.exports = {
  getSpotifyClientCredentialsToken,
  getUserAccessToken
};
