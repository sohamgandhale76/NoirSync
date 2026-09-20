/**
 * NoirSync Phase 6A: Authentication & Identity Regression Suite
 * 
 * Tests all 15 core requirements:
 *  1. Guest session creation (automatic UUID provisioning with is_guest = true)
 *  2. Registration of a new user
 *  3. Duplicate email rejection (HTTP 409 via database constraint)
 *  4. Duplicate username rejection (HTTP 409 via database constraint)
 *  5. Successful login with correct password (by email and by username)
 *  6. Invalid password rejection (HTTP 401)
 *  7. Logout (clears session cookie)
 *  8. /api/auth/me returns guest vs authenticated profile accurately
 *  9. Guest -> permanent account upgrade preserves the exact same UUID
 * 10. Playlist ownership survives guest -> account upgrade
 * 11. Connected Spotify account ownership survives guest -> account upgrade
 * 12. Session persistence (cookie survives refresh/subsequent calls)
 * 13. Password hash is never exposed in any API response
 * 14. Cross-user account isolation (User B cannot access User A's playlists or profile)
 * 15. Already-authenticated registration rejection (HTTP 409 when permanent user tries to register)
 */

const assert = require('assert');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

function parseCookies(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return {};
  const cookies = {};
  raw.split(',').forEach(chunk => {
    const part = chunk.split(';')[0].trim();
    const [name, ...val] = part.split('=');
    if (name) cookies[name] = val.join('=');
  });
  return cookies;
}

function getCookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function runAuthRegression() {
  console.log('--- STARTING PHASE 6A AUTH REGRESSION SUITE ---');
  let passed = 0;
  let total = 0;

  function pass(desc) {
    passed++;
    total++;
    console.log(`  PASS: [${total}] ${desc}`);
  }

  function fail(desc, err) {
    total++;
    console.error(`  FAIL: [${total}] ${desc}`);
    console.error(err);
    process.exitCode = 1;
  }

  const testSuffix = Date.now().toString().slice(-6);

  try {
    // ------------------------------------------------------------------------
    // Test 1: Guest Session Creation
    // ------------------------------------------------------------------------
    try {
      const res = await fetch(`${BASE_URL}/api/auth/me`);
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      const cookies = parseCookies(res);
      assert.ok(cookies['noirsync_session'], 'Expected noirsync_session cookie to be set');

      const data = await res.json();
      assert.strictEqual(data.authenticated, false, 'Guest should not be authenticated');
      assert.strictEqual(data.isGuest, true, 'isGuest should be true');
      assert.ok(data.user?.id, 'Guest user should have an id');

      // Verify in DB that is_guest = true
      const dbUser = await pool.query('SELECT * FROM users WHERE id = $1', [data.user.id]);
      assert.strictEqual(dbUser.rows.length, 1, 'User row must exist in DB');
      assert.strictEqual(dbUser.rows[0].is_guest, true, 'DB is_guest must be true');

      pass('Guest session created with automatic UUID and is_guest = true');
    } catch (e) {
      fail('Guest session creation', e);
    }

    // ------------------------------------------------------------------------
    // Test 2: Registration of a new user
    // ------------------------------------------------------------------------
    let sessionUser1Cookies = {};
    let user1Id = null;
    const user1Email = `user1_${testSuffix}@example.com`;
    const user1Username = `user1_${testSuffix}`;
    const user1Password = 'Password123!';

    try {
      // Step 1: establish guest session
      const meRes = await fetch(`${BASE_URL}/api/auth/me`);
      sessionUser1Cookies = parseCookies(meRes);
      const guestData = await meRes.json();
      user1Id = guestData.user.id;

      // Step 2: register
      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': getCookieHeader(sessionUser1Cookies),
        },
        body: JSON.stringify({
          email: user1Email,
          username: user1Username,
          displayName: 'User One',
          password: user1Password,
        }),
      });

      assert.strictEqual(regRes.status, 201, `Expected 201, got ${regRes.status}`);
      const regData = await regRes.json();
      assert.strictEqual(regData.success, true);
      assert.strictEqual(regData.user.email, user1Email);
      assert.strictEqual(regData.user.username, user1Username);
      assert.strictEqual(regData.user.displayName, 'User One');
      assert.strictEqual(regData.user.isGuest, false);
      assert.strictEqual(regData.user.id, user1Id, 'Upgraded user must preserve guest UUID');

      // Update cookie if refreshed
      const newCookies = parseCookies(regRes);
      if (newCookies['noirsync_session']) sessionUser1Cookies = newCookies;

      pass('Registration successful and upgraded guest identity');
    } catch (e) {
      fail('Registration of new user', e);
    }

    // ------------------------------------------------------------------------
    // Test 3: Duplicate email rejection (HTTP 409 via database constraint)
    // ------------------------------------------------------------------------
    try {
      // New guest session attempting to use user1's email
      const dupEmailRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user1Email.toUpperCase(), // Test case insensitivity
          username: `diff_user_${testSuffix}`,
          password: 'Password123!',
        }),
      });

      assert.strictEqual(dupEmailRes.status, 409, `Expected 409, got ${dupEmailRes.status}`);
      const errData = await dupEmailRes.json();
      assert.ok(errData.error.toLowerCase().includes('email'), `Error should mention email: ${errData.error}`);
      pass('Duplicate email rejected with HTTP 409');
    } catch (e) {
      fail('Duplicate email rejection', e);
    }

    // ------------------------------------------------------------------------
    // Test 4: Duplicate username rejection (HTTP 409 via database constraint)
    // ------------------------------------------------------------------------
    try {
      const dupUserRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `diff_email_${testSuffix}@example.com`,
          username: user1Username.toUpperCase(), // Test case insensitivity
          password: 'Password123!',
        }),
      });

      assert.strictEqual(dupUserRes.status, 409, `Expected 409, got ${dupUserRes.status}`);
      const errData = await dupUserRes.json();
      assert.ok(errData.error.toLowerCase().includes('username'), `Error should mention username: ${errData.error}`);
      pass('Duplicate username rejected with HTTP 409');
    } catch (e) {
      fail('Duplicate username rejection', e);
    }

    // ------------------------------------------------------------------------
    // Test 5: Successful login with correct password (by email and by username)
    // ------------------------------------------------------------------------
    let loginCookies = {};
    try {
      // Login by email
      const loginEmailRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: user1Email,
          password: user1Password,
        }),
      });

      assert.strictEqual(loginEmailRes.status, 200, `Expected 200, got ${loginEmailRes.status}`);
      const emailLoginData = await loginEmailRes.json();
      assert.strictEqual(emailLoginData.success, true);
      assert.strictEqual(emailLoginData.user.id, user1Id);
      loginCookies = parseCookies(loginEmailRes);

      // Login by username
      const loginUserRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: user1Username,
          password: user1Password,
        }),
      });

      assert.strictEqual(loginUserRes.status, 200, `Expected 200, got ${loginUserRes.status}`);
      const userLoginData = await loginUserRes.json();
      assert.strictEqual(userLoginData.success, true);
      assert.strictEqual(userLoginData.user.id, user1Id);

      pass('Successful login with email and username');
    } catch (e) {
      fail('Successful login', e);
    }

    // ------------------------------------------------------------------------
    // Test 6: Invalid password rejection (HTTP 401)
    // ------------------------------------------------------------------------
    try {
      const badPassRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: user1Email,
          password: 'WrongPassword!',
        }),
      });

      assert.strictEqual(badPassRes.status, 401, `Expected 401, got ${badPassRes.status}`);
      pass('Invalid password rejected with HTTP 401');
    } catch (e) {
      fail('Invalid password rejection', e);
    }

    // ------------------------------------------------------------------------
    // Test 7: Logout (clears session cookie)
    // ------------------------------------------------------------------------
    try {
      const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: {
          'Cookie': getCookieHeader(loginCookies),
        },
      });

      assert.strictEqual(logoutRes.status, 200);
      const logoutCookies = parseCookies(logoutRes);
      // Verify cookie is cleared (Max-Age=0 or empty)
      const rawCookie = logoutRes.headers.get('set-cookie') || '';
      assert.ok(rawCookie.includes('Max-Age=0'), 'Logout should set Max-Age=0');
      pass('Logout clears session cookie');
    } catch (e) {
      fail('Logout', e);
    }

    // ------------------------------------------------------------------------
    // Test 8: /api/auth/me returns guest vs authenticated profile
    // ------------------------------------------------------------------------
    try {
      // Authenticated me check
      const authMeRes = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: { 'Cookie': getCookieHeader(sessionUser1Cookies) },
      });
      assert.strictEqual(authMeRes.status, 200);
      const authMeData = await authMeRes.json();
      assert.strictEqual(authMeData.authenticated, true);
      assert.strictEqual(authMeData.isGuest, false);
      assert.strictEqual(authMeData.user.email, user1Email);

      // Unauthenticated me check (no cookies)
      const unauthMeRes = await fetch(`${BASE_URL}/api/auth/me`);
      assert.strictEqual(unauthMeRes.status, 200);
      const unauthMeData = await unauthMeRes.json();
      assert.strictEqual(unauthMeData.authenticated, false);
      assert.strictEqual(unauthMeData.isGuest, true);

      pass('/api/auth/me accurately differentiates authenticated and guest states');
    } catch (e) {
      fail('/api/auth/me inspection', e);
    }

    // ------------------------------------------------------------------------
    // Test 9: Guest -> permanent account upgrade preserves exact UUID
    // ------------------------------------------------------------------------
    let user2Id = null;
    let user2Cookies = {};
    const user2Email = `user2_${testSuffix}@example.com`;
    const user2Username = `user2_${testSuffix}`;

    try {
      const guestRes = await fetch(`${BASE_URL}/api/auth/me`);
      user2Cookies = parseCookies(guestRes);
      const guestData = await guestRes.json();
      user2Id = guestData.user.id;

      const upgradeRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': getCookieHeader(user2Cookies),
        },
        body: JSON.stringify({
          email: user2Email,
          username: user2Username,
          password: 'Password123!',
        }),
      });

      assert.strictEqual(upgradeRes.status, 201);
      const upgradeData = await upgradeRes.json();
      assert.strictEqual(upgradeData.user.id, user2Id, 'Upgraded UUID must equal guest UUID');
      assert.strictEqual(upgradeData.user.isGuest, false);

      pass('Guest -> permanent account upgrade preserves the exact same UUID');
    } catch (e) {
      fail('Guest -> account upgrade UUID preservation', e);
    }

    // ------------------------------------------------------------------------
    // Test 10: Playlist ownership survives guest -> account upgrade
    // ------------------------------------------------------------------------
    try {
      // Step A: Create fresh guest session
      const gRes = await fetch(`${BASE_URL}/api/auth/me`);
      let gCookies = parseCookies(gRes);
      const gData = await gRes.json();
      const guestUserId = gData.user.id;

      // Step B: Create a playlist while guest
      const plRes = await fetch(`${BASE_URL}/api/playlists`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': getCookieHeader(gCookies),
        },
        body: JSON.stringify({
          name: `Guest Playlist ${testSuffix}`,
          description: 'Created as guest',
        }),
      });

      assert.strictEqual(plRes.status, 201, `Expected 201, got ${plRes.status}`);
      const plData = await plRes.json();
      const playlistId = plData.playlist.id;
      assert.strictEqual(plData.playlist.user_id, guestUserId);

      // Step C: Upgrade guest to permanent account
      const upRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': getCookieHeader(gCookies),
        },
        body: JSON.stringify({
          email: `upgraded_pl_${testSuffix}@example.com`,
          username: `upgraded_pl_${testSuffix}`,
          password: 'Password123!',
        }),
      });
      assert.strictEqual(upRes.status, 201);
      const upCookies = parseCookies(upRes);
      if (upCookies['noirsync_session']) gCookies = upCookies;

      // Step D: Retrieve playlist after upgrade using the authenticated session
      const getPlRes = await fetch(`${BASE_URL}/api/playlists/${playlistId}`, {
        headers: { 'Cookie': getCookieHeader(gCookies) },
      });
      assert.strictEqual(getPlRes.status, 200, `Expected 200, got ${getPlRes.status}`);
      const getPlData = await getPlRes.json();
      assert.strictEqual(getPlData.playlist.id, playlistId);
      assert.strictEqual(getPlData.playlist.user_id, guestUserId);
      assert.strictEqual(getPlData.playlist.name, `Guest Playlist ${testSuffix}`);

      pass('Playlist ownership survives guest -> permanent account upgrade');
    } catch (e) {
      fail('Playlist ownership upgrade survival', e);
    }

    // ------------------------------------------------------------------------
    // Test 11: Connected Spotify account ownership survives upgrade
    // ------------------------------------------------------------------------
    try {
      // Step A: Create fresh guest session
      const gRes = await fetch(`${BASE_URL}/api/auth/me`);
      let gCookies = parseCookies(gRes);
      const gData = await gRes.json();
      const guestUserId = gData.user.id;

      // Step B: Insert a connected_accounts row directly for this guest user
      const { v4: uuidv4 } = require('uuid');
      const connId = uuidv4();
      const providerAccountId = `spotify_user_${testSuffix}`;
      await pool.query(
        `INSERT INTO connected_accounts (id, user_id, provider, provider_account_id, display_name, created_at, updated_at)
         VALUES ($1, $2, 'spotify', $3, 'Spotify Tester', $4, $4)`,
        [connId, guestUserId, providerAccountId, Date.now()]
      );

      // Step C: Upgrade guest
      const upRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': getCookieHeader(gCookies),
        },
        body: JSON.stringify({
          email: `upgraded_spot_${testSuffix}@example.com`,
          username: `upgraded_spot_${testSuffix}`,
          password: 'Password123!',
        }),
      });
      assert.strictEqual(upRes.status, 201);
      const upCookies = parseCookies(upRes);
      if (upCookies['noirsync_session']) gCookies = upCookies;

      // Step D: Verify /api/music/accounts returns the Spotify account
      const accRes = await fetch(`${BASE_URL}/api/music/accounts`, {
        headers: { 'Cookie': getCookieHeader(gCookies) },
      });
      assert.strictEqual(accRes.status, 200);
      const accounts = await accRes.json();
      const spotifyAcc = accounts.find(a => a.provider === 'spotify');
      assert.ok(spotifyAcc, 'Spotify account must be present');
      assert.strictEqual(spotifyAcc.providerAccountId, providerAccountId);

      pass('Connected Spotify account ownership survives upgrade');
    } catch (e) {
      fail('Spotify account upgrade survival', e);
    }

    // ------------------------------------------------------------------------
    // Test 12: Session survives refresh
    // ------------------------------------------------------------------------
    try {
      // Send two successive requests with user1's cookie
      const res1 = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: { 'Cookie': getCookieHeader(sessionUser1Cookies) },
      });
      const data1 = await res1.json();

      const res2 = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: { 'Cookie': getCookieHeader(sessionUser1Cookies) },
      });
      const data2 = await res2.json();

      assert.strictEqual(data1.user.id, user1Id);
      assert.strictEqual(data2.user.id, user1Id);
      assert.strictEqual(data2.authenticated, true);

      pass('Session survives refresh across multiple requests');
    } catch (e) {
      fail('Session persistence', e);
    }

    // ------------------------------------------------------------------------
    // Test 13: Password hash never appears in API response
    // ------------------------------------------------------------------------
    try {
      // 1. Check register response
      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `safe_user_${testSuffix}@example.com`,
          username: `safe_user_${testSuffix}`,
          password: 'Password123!',
        }),
      });
      const regText = await regRes.text();
      assert.ok(!regText.includes('password_hash'), 'Register response must not contain password_hash');
      assert.ok(!regText.includes('$2a$') && !regText.includes('$2b$'), 'Register response must not contain bcrypt hash');

      // 2. Check login response
      const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: `safe_user_${testSuffix}`,
          password: 'Password123!',
        }),
      });
      const loginText = await loginRes.text();
      assert.ok(!loginText.includes('password_hash'), 'Login response must not contain password_hash');
      assert.ok(!loginText.includes('$2a$') && !loginText.includes('$2b$'), 'Login response must not contain bcrypt hash');

      // 3. Check /me response
      const meCookies = parseCookies(loginRes);
      const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: { 'Cookie': getCookieHeader(meCookies) },
      });
      const meText = await meRes.text();
      assert.ok(!meText.includes('password_hash'), '/me response must not contain password_hash');
      assert.ok(!meText.includes('$2a$') && !meText.includes('$2b$'), '/me response must not contain bcrypt hash');

      pass('Password hash is never exposed in any API response');
    } catch (e) {
      fail('Password hash non-disclosure', e);
    }

    // ------------------------------------------------------------------------
    // Test 14: Cross-user account isolation
    // ------------------------------------------------------------------------
    try {
      // Create user A
      const resA = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `iso_a_${testSuffix}@example.com`,
          username: `iso_a_${testSuffix}`,
          password: 'Password123!',
        }),
      });
      const cookiesA = parseCookies(resA);

      // Create playlist as User A
      const plARes = await fetch(`${BASE_URL}/api/playlists`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': getCookieHeader(cookiesA),
        },
        body: JSON.stringify({ name: 'Private Playlist A' }),
      });
      const plA = await plARes.json();

      // Create user B
      const resB = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `iso_b_${testSuffix}@example.com`,
          username: `iso_b_${testSuffix}`,
          password: 'Password123!',
        }),
      });
      const cookiesB = parseCookies(resB);

      // User B attempts to access User A's playlist
      const accessRes = await fetch(`${BASE_URL}/api/playlists/${plA.playlist.id}`, {
        headers: { 'Cookie': getCookieHeader(cookiesB) },
      });
      assert.strictEqual(accessRes.status, 404, 'User B must not be able to read User A playlist');

      // User B attempts to delete User A's playlist
      const delRes = await fetch(`${BASE_URL}/api/playlists/${plA.playlist.id}`, {
        method: 'DELETE',
        headers: { 'Cookie': getCookieHeader(cookiesB) },
      });
      assert.strictEqual(delRes.status, 404, 'User B must not be able to delete User A playlist');

      pass('Cross-user account isolation strictly enforced');
    } catch (e) {
      fail('Cross-user isolation', e);
    }

    // ------------------------------------------------------------------------
    // Test 15: Already-authenticated permanent user registration rejection
    // ------------------------------------------------------------------------
    try {
      // Attempt to register while already authenticated as User 1
      const rejRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': getCookieHeader(sessionUser1Cookies),
        },
        body: JSON.stringify({
          email: `new_attempt_${testSuffix}@example.com`,
          username: `new_attempt_${testSuffix}`,
          password: 'Password123!',
        }),
      });

      assert.strictEqual(rejRes.status, 409, `Expected 409 Conflict, got ${rejRes.status}`);
      const rejData = await rejRes.json();
      assert.ok(
        rejData.error.toLowerCase().includes('already authenticated'),
        `Error message should state already authenticated: ${rejData.error}`
      );

      pass('Already-authenticated permanent user registration rejected with HTTP 409');
    } catch (e) {
      fail('Already-authenticated registration rejection', e);
    }

  } finally {
    await pool.end();
  }

  console.log(`\n--- TEST RESULTS: ${passed}/${total} PASS ---`);
  if (passed === total && total === 15) {
    console.log('ALL 15 AUTH REGRESSION TESTS PASSED SUCCESSFULLY!');
  } else {
    console.error(`FAILED: ${total - passed} tests failed.`);
    process.exit(1);
  }
}

runAuthRegression().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
