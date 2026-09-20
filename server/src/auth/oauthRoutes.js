const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { encrypt } = require('./crypto');
const logger = require('../logger');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// Supported OAuth providers
const PROVIDERS = {
  spotify: {
    authUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    scopes: 'user-read-private user-read-email' // Minimal scope for identifying the user
  }
};

function getFrontendUrl() {
  if (process.env.CLIENT_URL) {
    return process.env.CLIENT_URL.replace(/\/+$/, '');
  }
  if (process.env.NODE_ENV === 'production' && process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*') {
    return process.env.CORS_ORIGIN.replace(/\/+$/, '');
  }
  return 'http://localhost:5173';
}

function getRedirectUri(req, provider) {
  if (process.env.SPOTIFY_REDIRECT_URI && provider === 'spotify') {
    return process.env.SPOTIFY_REDIRECT_URI;
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers.host || 'localhost:3001';
  return `${protocol}://${host}/api/music/callback/${provider}`;
}

// Start OAuth Flow
router.get('/connect/:provider', async (req, res) => {
  const provider = req.params.provider;
  if (!PROVIDERS[provider]) return res.status(400).json({ error: 'Unsupported provider' });

  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  // Generate secure random state
  const state = crypto.randomBytes(32).toString('hex');
  
  // Store state in db to prevent CSRF
  await db.pool.query(
    'INSERT INTO oauth_states (state, user_id, provider, created_at) VALUES ($1, $2, $3, $4)',
    [state, userId, provider, Date.now()]
  );

  let redirectUrl = '';
  if (provider === 'spotify') {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const redirectUri = getRedirectUri(req, provider);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: PROVIDERS.spotify.scopes,
      redirect_uri: redirectUri,
      state: state
    });
    redirectUrl = `${PROVIDERS.spotify.authUrl}?${params.toString()}`;
  }

  res.redirect(redirectUrl);
});

// OAuth Callback
router.get('/callback/:provider', async (req, res) => {
  const provider = req.params.provider;
  const { code, state, error } = req.query;
  const userId = req.userId;
  const frontendUrl = getFrontendUrl();

  if (error) {
    logger.warn(`OAuth callback error from provider ${provider}`, { error });
    const safeError = error === 'access_denied' ? 'access_denied' : 'provider_auth_failed';
    return res.redirect(`${frontendUrl}/?spotify_error=${safeError}`);
  }

  if (!code || !state) {
    return res.redirect(`${frontendUrl}/?spotify_error=invalid_state`);
  }

  // Validate state
  const stateResult = await db.pool.query(
    'SELECT * FROM oauth_states WHERE state = $1 AND provider = $2 AND user_id = $3',
    [state, provider, userId]
  );

  if (stateResult.rows.length === 0) {
    logger.warn('Invalid OAuth state encountered', { userId, provider });
    return res.redirect(`${frontendUrl}/?spotify_error=invalid_state`);
  }

  const stateRecord = stateResult.rows[0];
  
  // Consume state immediately
  await db.pool.query('DELETE FROM oauth_states WHERE state = $1', [state]);

  // Check expiration (10 minutes)
  if (Date.now() - stateRecord.created_at > 10 * 60 * 1000) {
    return res.redirect(`${frontendUrl}/?spotify_error=state_expired`);
  }

  try {
    let accessToken, refreshToken, expiresAt, providerAccountId, displayName;

    if (provider === 'spotify') {
      const clientId = process.env.SPOTIFY_CLIENT_ID;
      const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
      const redirectUri = getRedirectUri(req, provider);

      const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const params = new URLSearchParams({
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      });

      const tokenRes = await fetch(PROVIDERS.spotify.tokenUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authString}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });

      if (!tokenRes.ok) {
        throw new Error('token_exchange_failed');
      }

      const tokenData = await tokenRes.json();
      accessToken = tokenData.access_token;
      refreshToken = tokenData.refresh_token;
      expiresAt = Date.now() + (tokenData.expires_in * 1000);

      // Fetch user profile to get provider account ID
      const profileRes = await fetch('https://api.spotify.com/v1/me', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!profileRes.ok) {
        throw new Error('profile_fetch_failed');
      }

      const profile = await profileRes.json();
      providerAccountId = profile.id;
      displayName = profile.display_name || profile.id;
    }

    // Check if this provider account is already linked to another NoirSync user
    const existingOther = await db.pool.query(
      'SELECT user_id FROM connected_accounts WHERE provider = $1 AND provider_account_id = $2 AND user_id != $3',
      [provider, providerAccountId, userId]
    );

    if (existingOther.rows.length > 0) {
      logger.warn('Spotify account is already linked to another user', { provider, providerAccountId, currentUserId: userId });
      return res.redirect(`${frontendUrl}/?spotify_error=account_already_linked`);
    }

    // Encrypt tokens and store connected account
    const id = uuidv4();
    await db.pool.query(
      `INSERT INTO connected_accounts (id, user_id, provider, provider_account_id, display_name, access_token_enc, refresh_token_enc, expires_at, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         provider_account_id = EXCLUDED.provider_account_id,
         display_name = EXCLUDED.display_name,
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at`,
      [id, userId, provider, providerAccountId, displayName, encrypt(accessToken), encrypt(refreshToken), expiresAt, PROVIDERS[provider].scopes, Date.now(), Date.now()]
    );

    logger.info('User successfully connected provider account', { userId, provider, providerAccountId });
    res.redirect(`${frontendUrl}/?spotify_connected=true`);
  } catch (err) {
    if (err.code === '23505') {
      logger.warn('Spotify account already linked (unique constraint violation)', { error: err.message });
      return res.redirect(`${frontendUrl}/?spotify_error=account_already_linked`);
    }
    logger.error('OAuth token exchange error', { error: err.message });
    const safeError = err.message === 'profile_fetch_failed' ? 'profile_fetch_failed' : 'token_exchange_failed';
    res.redirect(`${frontendUrl}/?spotify_error=${safeError}`);
  }
});

// Disconnect provider
router.post('/disconnect/:provider', async (req, res) => {
  const provider = req.params.provider;
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  await db.pool.query('DELETE FROM connected_accounts WHERE user_id = $1 AND provider = $2', [userId, provider]);
  logger.info('User disconnected provider account', { userId, provider });
  res.json({ success: true });
});

// List connected accounts (safe metadata only)
router.get('/accounts', async (req, res) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const result = await db.pool.query(
    'SELECT provider, provider_account_id, display_name FROM connected_accounts WHERE user_id = $1',
    [userId]
  );
  
  const accounts = result.rows.map(row => ({
    provider: row.provider,
    connected: true,
    providerAccountId: row.provider_account_id,
    displayName: row.display_name || row.provider_account_id
  }));

  res.json(accounts);
});

module.exports = router;
