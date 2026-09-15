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

const getRedirectUri = (req, provider) => {
  // Determine absolute redirect URI
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers.host;
  return `${protocol}://${host}/api/music/callback/${provider}`;
};

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

  if (error) {
    logger.error(`OAuth callback error for ${provider}`, { error });
    return res.redirect('/?error=provider_auth_failed');
  }

  if (!code || !state) {
    return res.redirect('/?error=invalid_oauth_response');
  }

  // Validate state
  const stateResult = await db.pool.query(
    'SELECT * FROM oauth_states WHERE state = $1 AND provider = $2 AND user_id = $3',
    [state, provider, userId]
  );

  if (stateResult.rows.length === 0) {
    logger.warn('Invalid OAuth state encountered', { userId, provider });
    return res.redirect('/?error=invalid_state');
  }

  const stateRecord = stateResult.rows[0];
  
  // Consume state immediately
  await db.pool.query('DELETE FROM oauth_states WHERE state = $1', [state]);

  // Check expiration (e.g. 10 minutes)
  if (Date.now() - stateRecord.created_at > 10 * 60 * 1000) {
    return res.redirect('/?error=state_expired');
  }

  try {
    let accessToken, refreshToken, expiresAt, providerAccountId;

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
        throw new Error(`Token exchange failed: ${tokenRes.status}`);
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
        throw new Error('Failed to fetch provider profile');
      }

      const profile = await profileRes.json();
      providerAccountId = profile.id;
    }

    // Encrypt tokens and store connected account
    const id = uuidv4();
    await db.pool.query(
      `INSERT INTO connected_accounts (id, user_id, provider, provider_account_id, access_token_enc, refresh_token_enc, expires_at, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         provider_account_id = EXCLUDED.provider_account_id,
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at`,
      [id, userId, provider, providerAccountId, encrypt(accessToken), encrypt(refreshToken), expiresAt, PROVIDERS[provider].scopes, Date.now(), Date.now()]
    );

    logger.info('User successfully connected provider account', { userId, provider });
    res.redirect('/');
  } catch (err) {
    logger.error('OAuth token exchange error', { error: err.message, stack: err.stack });
    res.redirect('/?error=token_exchange_failed');
  }
});

// Disconnect provider
router.post('/disconnect/:provider', async (req, res) => {
  const provider = req.params.provider;
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  await db.pool.query('DELETE FROM connected_accounts WHERE user_id = $1 AND provider = $2', [userId, provider]);
  res.json({ success: true });
});

// List connected accounts (safe metadata only)
router.get('/accounts', async (req, res) => {
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const result = await db.pool.query('SELECT provider, provider_account_id FROM connected_accounts WHERE user_id = $1', [userId]);
  
  const accounts = result.rows.map(row => ({
    provider: row.provider,
    connected: true,
    providerAccountId: row.provider_account_id
  }));

  res.json(accounts);
});

module.exports = router;
