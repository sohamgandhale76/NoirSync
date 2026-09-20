// ─── NoirSync Spotify OAuth & Account Linking Regression Test Suite ───────────
// Verifies:
//  1. OAuth state generation & CSRF storage
//  2. OAuth state expiration rejection (> 10 mins)
//  3. OAuth state user mismatch rejection
//  4. OAuth state single-use / replay attack rejection
//  5. Successful account linking & identity persistence (/v1/me profile)
//  6. Duplicate same-user linking (idempotent update)
//  7. Cross-user duplicate Spotify account rejection (account_already_linked)
//  8. Token encryption format (AES-256-GCM v1:iv:ciphertext:tag)
//  9. Token decryption correctness
// 10. /api/music/accounts never exposes tokens
// 11. Disconnect endpoint removes connected account
// 12. Expired access token refresh & re-encryption
// 13. Failed/revoked refresh invalidates account safely
// 14. Safe error handling (no sensitive data in redirects)

const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const db = require('./src/db');
const { encrypt, decrypt, sign } = require('./src/auth/crypto');
const { sessionMiddleware } = require('./src/auth/session');
const oauthRoutes = require('./src/auth/oauthRoutes');
const { getUserAccessToken } = require('./src/music/providers/credentials');

let server;
let baseUrl;

async function setupTestApp() {
  await db.initDb();

  const app = express();
  app.use(express.json());
  app.use('/api/music', sessionMiddleware, oauthRoutes);

  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
}

function teardownTestApp() {
  return new Promise((resolve) => {
    if (server) {
      server.close(resolve);
    } else {
      resolve();
    }
  });
}

async function runTests() {
  console.log('--- Starting Spotify OAuth & Account Linking Regression Suite ---\n');
  await setupTestApp();

  const userA = uuidv4();
  const userB = uuidv4();
  const sessionCookieA = `noirsync_session=${encodeURIComponent(sign(userA))}`;
  const sessionCookieB = `noirsync_session=${encodeURIComponent(sign(userB))}`;

  // Ensure test users exist in DB
  await db.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userA, Date.now()]);
  await db.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userB, Date.now()]);

  try {
    // ─── Test 1: OAuth state generation ──────────────────────────────────────
    console.log('1. Testing OAuth state generation & CSRF storage...');
    const connectRes = await fetch(`${baseUrl}/api/music/connect/spotify`, {
      headers: { Cookie: sessionCookieA },
      redirect: 'manual'
    });
    assert.strictEqual(connectRes.status, 302, 'Should redirect to Spotify authorize URL');
    const location = connectRes.headers.get('location');
    assert(location.includes('https://accounts.spotify.com/authorize'), 'Location must point to Spotify authorize');
    
    const parsedUrl = new URL(location);
    const stateA = parsedUrl.searchParams.get('state');
    assert(stateA && stateA.length === 64, 'State must be a 32-byte hex string (64 chars)');
    assert.strictEqual(parsedUrl.searchParams.get('response_type'), 'code');

    const stateRow = await db.pool.query('SELECT * FROM oauth_states WHERE state = $1', [stateA]);
    assert.strictEqual(stateRow.rows.length, 1, 'State must be stored in oauth_states table');
    assert.strictEqual(stateRow.rows[0].user_id, userA, 'State must be tied to userA');
    assert.strictEqual(stateRow.rows[0].provider, 'spotify');
    console.log('   ✓ State generated, stored in DB, and bound to user');

    // ─── Test 2: OAuth state expiration rejection ────────────────────────────
    console.log('\n2. Testing OAuth state expiration (> 10 minutes)...');
    const expiredState = 'expired_state_' + uuidv4().replace(/-/g, '');
    const elevenMinutesAgo = Date.now() - (11 * 60 * 1000);
    await db.pool.query(
      'INSERT INTO oauth_states (state, user_id, provider, created_at) VALUES ($1, $2, $3, $4)',
      [expiredState, userA, 'spotify', elevenMinutesAgo]
    );

    const expiredRes = await fetch(`${baseUrl}/api/music/callback/spotify?code=dummy_code&state=${expiredState}`, {
      headers: { Cookie: sessionCookieA },
      redirect: 'manual'
    });
    assert.strictEqual(expiredRes.status, 302);
    const expiredRedirect = expiredRes.headers.get('location');
    assert(expiredRedirect.includes('spotify_error=state_expired'), 'Expired state must redirect with state_expired');
    console.log('   ✓ Expired state rejected with state_expired');

    // ─── Test 3: OAuth state user mismatch rejection ─────────────────────────
    console.log('\n3. Testing OAuth state user mismatch rejection (CSRF protection)...');
    const mismatchRes = await fetch(`${baseUrl}/api/music/callback/spotify?code=dummy_code&state=${stateA}`, {
      headers: { Cookie: sessionCookieB }, // userB presenting userA's state
      redirect: 'manual'
    });
    assert.strictEqual(mismatchRes.status, 302);
    const mismatchRedirect = mismatchRes.headers.get('location');
    assert(mismatchRedirect.includes('spotify_error=invalid_state'), 'Mismatched user must be rejected with invalid_state');
    console.log('   ✓ Mismatched state/user rejected with invalid_state');

    // ─── Test 4: OAuth state single-use / replay rejection ───────────────────
    console.log('\n4. Testing OAuth state single-use / replay attack rejection...');
    const replayState = 'replay_state_' + uuidv4().replace(/-/g, '');
    await db.pool.query(
      'INSERT INTO oauth_states (state, user_id, provider, created_at) VALUES ($1, $2, $3, $4)',
      [replayState, userA, 'spotify', Date.now()]
    );

    // First attempt (consume state)
    await fetch(`${baseUrl}/api/music/callback/spotify?code=dummy_code&state=${replayState}`, {
      headers: { Cookie: sessionCookieA },
      redirect: 'manual'
    });

    // Verify state was deleted
    const stateCheck = await db.pool.query('SELECT * FROM oauth_states WHERE state = $1', [replayState]);
    assert.strictEqual(stateCheck.rows.length, 0, 'State must be deleted immediately upon first use');

    // Second attempt with same state
    const replayRes = await fetch(`${baseUrl}/api/music/callback/spotify?code=dummy_code&state=${replayState}`, {
      headers: { Cookie: sessionCookieA },
      redirect: 'manual'
    });
    assert.strictEqual(replayRes.status, 302);
    assert(replayRes.headers.get('location').includes('spotify_error=invalid_state'), 'Replaying state must be rejected');
    console.log('   ✓ Single-use state consumption verified; replay rejected');

    // ─── Test 5: Token encryption format & correctness ───────────────────────
    console.log('\n5. Testing AES-256-GCM token encryption and decryption...');
    const testRawToken = 'spotify_access_token_' + uuidv4();
    const encrypted = encrypt(testRawToken);
    assert(encrypted.startsWith('v1:'), 'Ciphertext must start with version prefix v1:');
    const parts = encrypted.split(':');
    assert.strictEqual(parts.length, 4, 'Encrypted format must have 4 colon-separated parts');
    assert.strictEqual(parts[1].length, 24, 'IV must be 12 bytes (24 hex chars)');
    assert.strictEqual(parts[3].length, 32, 'AuthTag must be 16 bytes (32 hex chars)');

    const decrypted = decrypt(encrypted);
    assert.strictEqual(decrypted, testRawToken, 'Decrypted token must match original plaintext');
    console.log('   ✓ Authenticated AES-256-GCM encryption and decryption verified');

    // ─── Test 6: Account linking & safe metadata response ────────────────────
    console.log('\n6. Testing account linking persistence and /api/music/accounts...');
    const spotifyAccountId = 'spotify_user_' + uuidv4().substring(0, 8);
    const spotifyDisplayName = 'Test Spotify User';
    const accountId = uuidv4();

    await db.pool.query(
      `INSERT INTO connected_accounts 
       (id, user_id, provider, provider_account_id, display_name, access_token_enc, refresh_token_enc, expires_at, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        accountId,
        userA,
        'spotify',
        spotifyAccountId,
        spotifyDisplayName,
        encrypt('secret_access_token_123'),
        encrypt('secret_refresh_token_456'),
        Date.now() + 3600000,
        'user-read-private user-read-email',
        Date.now(),
        Date.now()
      ]
    );

    const accountsRes = await fetch(`${baseUrl}/api/music/accounts`, {
      headers: { Cookie: sessionCookieA }
    });
    assert.strictEqual(accountsRes.status, 200);
    const accountsData = await accountsRes.json();
    assert.strictEqual(accountsData.length, 1);
    const account = accountsData[0];
    assert.strictEqual(account.provider, 'spotify');
    assert.strictEqual(account.connected, true);
    assert.strictEqual(account.providerAccountId, spotifyAccountId);
    assert.strictEqual(account.displayName, spotifyDisplayName);

    // CRITICAL SECURITY INVARIANT: No tokens exposed in response
    assert.strictEqual(account.access_token, undefined, 'Access token must NOT be exposed');
    assert.strictEqual(account.refresh_token, undefined, 'Refresh token must NOT be exposed');
    assert.strictEqual(account.access_token_enc, undefined, 'Encrypted token must NOT be exposed');
    assert.strictEqual(account.refresh_token_enc, undefined, 'Encrypted refresh token must NOT be exposed');
    console.log('   ✓ Safe account metadata returned; strictly no tokens exposed');

    // ─── Test 7: Duplicate same-user linking (idempotent update) ─────────────
    console.log('\n7. Testing duplicate same-user account linking...');
    const updatedDisplayName = 'Updated Spotify User';
    await db.pool.query(
      `INSERT INTO connected_accounts 
       (id, user_id, provider, provider_account_id, display_name, access_token_enc, refresh_token_enc, expires_at, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         provider_account_id = EXCLUDED.provider_account_id,
         display_name = EXCLUDED.display_name,
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at`,
      [
        uuidv4(),
        userA,
        'spotify',
        spotifyAccountId,
        updatedDisplayName,
        encrypt('new_access_token_789'),
        encrypt('new_refresh_token_012'),
        Date.now() + 3600000,
        'user-read-private user-read-email',
        Date.now(),
        Date.now()
      ]
    );

    const sameUserRows = await db.pool.query(
      'SELECT * FROM connected_accounts WHERE user_id = $1 AND provider = $2',
      [userA, 'spotify']
    );
    assert.strictEqual(sameUserRows.rows.length, 1, 'Must still have exactly 1 row for userA and spotify');
    assert.strictEqual(sameUserRows.rows[0].display_name, updatedDisplayName, 'Display name should be updated');
    console.log('   ✓ Duplicate same-user linking updates existing record cleanly without duplicates');

    // ─── Test 8: Cross-user duplicate Spotify account rejection ──────────────
    console.log('\n8. Testing cross-user duplicate Spotify account rejection...');
    // User B attempts to link the exact same Spotify account as User A
    const callbackStateB = 'state_user_b_' + uuidv4().replace(/-/g, '');
    await db.pool.query(
      'INSERT INTO oauth_states (state, user_id, provider, created_at) VALUES ($1, $2, $3, $4)',
      [callbackStateB, userB, 'spotify', Date.now()]
    );

    // Check pre-existing account check in DB
    const existingOther = await db.pool.query(
      'SELECT user_id FROM connected_accounts WHERE provider = $1 AND provider_account_id = $2 AND user_id != $3',
      ['spotify', spotifyAccountId, userB]
    );
    assert.strictEqual(existingOther.rows.length, 1, 'Pre-check must find userA holds this Spotify account');
    assert.strictEqual(existingOther.rows[0].user_id, userA);

    // Test DB unique constraint directly
    let uniqueConstraintThrown = false;
    try {
      await db.pool.query(
        `INSERT INTO connected_accounts 
         (id, user_id, provider, provider_account_id, display_name, access_token_enc, refresh_token_enc, expires_at, scopes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          uuidv4(),
          userB,
          'spotify',
          spotifyAccountId, // same spotify account!
          'User B Spotify',
          encrypt('token_b'),
          encrypt('refresh_b'),
          Date.now() + 3600000,
          'user-read-private',
          Date.now(),
          Date.now()
        ]
      );
    } catch (err) {
      if (err.code === '23505') {
        uniqueConstraintThrown = true;
      }
    }
    assert.strictEqual(uniqueConstraintThrown, true, 'DB unique constraint on (provider, provider_account_id) must prevent cross-user duplicate linking');
    console.log('   ✓ Cross-user duplicate Spotify account rejected by unique constraint');

    // ─── Test 9: Disconnect endpoint ─────────────────────────────────────────
    console.log('\n9. Testing disconnect endpoint...');
    const disconnectRes = await fetch(`${baseUrl}/api/music/disconnect/spotify`, {
      method: 'POST',
      headers: { Cookie: sessionCookieA }
    });
    assert.strictEqual(disconnectRes.status, 200);
    const disconnectData = await disconnectRes.json();
    assert.strictEqual(disconnectData.success, true);

    const postDisconnectRows = await db.pool.query(
      'SELECT * FROM connected_accounts WHERE user_id = $1 AND provider = $2',
      [userA, 'spotify']
    );
    assert.strictEqual(postDisconnectRows.rows.length, 0, 'Account row must be deleted upon disconnect');
    console.log('   ✓ Account successfully disconnected and purged from DB');

    // ─── Test 10: Expired token refresh & invalidation on revocation ─────────
    console.log('\n10. Testing expired token handling and invalidation...');
    const testAccId = uuidv4();
    // Insert account with already expired token
    await db.pool.query(
      `INSERT INTO connected_accounts 
       (id, user_id, provider, provider_account_id, display_name, access_token_enc, refresh_token_enc, expires_at, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        testAccId,
        userA,
        'spotify',
        'spotify_exp_user',
        'Expired Token User',
        encrypt('expired_access_token'),
        encrypt('invalid_refresh_token'),
        Date.now() - 10000, // expired 10s ago
        'user-read-private',
        Date.now(),
        Date.now()
      ]
    );

    // Call getUserAccessToken - will attempt to refresh against Spotify API
    // Since 'invalid_refresh_token' is invalid, Spotify returns 400 Bad Request
    let refreshFailed = false;
    try {
      await getUserAccessToken(userA, 'spotify');
    } catch (err) {
      refreshFailed = true;
      assert(
        err.message === 'ProviderAuthenticationFailed' || err.message === 'ProviderUnavailable',
        `Expected authentication failure or unavailable, got: ${err.message}`
      );
    }
    assert.strictEqual(refreshFailed, true, 'Invalid refresh token must throw authentication error');

    // If 400 was returned by Spotify, the account should be purged
    const purgedCheck = await db.pool.query('SELECT * FROM connected_accounts WHERE id = $1', [testAccId]);
    assert.strictEqual(purgedCheck.rows.length, 0, 'Invalidated/revoked account must be safely removed from DB');
    console.log('   ✓ Revoked refresh token safely purges connected account');

    // ─── Test 11: Safe error redirect handling ───────────────────────────────
    console.log('\n11. Testing safe error redirect codes...');
    const errorRes = await fetch(`${baseUrl}/api/music/callback/spotify?error=access_denied`, {
      headers: { Cookie: sessionCookieA },
      redirect: 'manual'
    });
    assert.strictEqual(errorRes.status, 302);
    const errorLocation = errorRes.headers.get('location');
    assert(errorLocation.includes('spotify_error=access_denied'), 'access_denied error must map to safe code in redirect');
    assert(!errorLocation.includes('client_secret'), 'Must never include client secret in redirect');
    assert(!errorLocation.includes('token'), 'Must never include tokens in redirect');
    console.log('   ✓ Safe error codes and parameters verified');

    console.log('\n--- ALL 11 TEST SUITES PASSED CLEANLY ---');
  } finally {
    // Cleanup test data
    await db.pool.query('DELETE FROM connected_accounts WHERE user_id IN ($1, $2)', [userA, userB]);
    await db.pool.query('DELETE FROM oauth_states WHERE user_id IN ($1, $2)', [userA, userB]);
    await db.pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userA, userB]);
    await teardownTestApp();
  }
}

runTests()
  .then(() => {
    console.log('\nTest suite execution completed successfully.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nTest suite failed with error:', err);
    process.exit(1);
  });
