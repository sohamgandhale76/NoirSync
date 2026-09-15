const http = require('http');
const assert = require('assert');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function request(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: data
      }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runRuntimeSuite() {
  console.log('=== STARTING NON-SPOTIFY RUNTIME VERIFICATION SUITE ===\n');

  // Test 1: Server Health Check
  console.log('1. Checking Server Health (/health)...');
  const healthRes = await request({ hostname: '127.0.0.1', port: 3001, path: '/health', method: 'GET' });
  assert.strictEqual(healthRes.statusCode, 200, 'Health endpoint must return 200');
  const healthJson = JSON.parse(healthRes.body);
  assert.strictEqual(healthJson.status, 'ok', 'Status must be ok');
  console.log('PASS: /health returned status: ok');

  // Test 2: Session Creation & Cookie Flags
  console.log('\n2. Testing Session Creation & Cookie Flags...');
  const initialRes = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/music/accounts', method: 'GET' });
  assert.strictEqual(initialRes.statusCode, 200);
  const setCookie = initialRes.headers['set-cookie'];
  assert(setCookie, 'Must return Set-Cookie header');
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert(cookieStr.includes('noirsync_session='), 'Must include cookie name noirsync_session');
  assert(cookieStr.includes('HttpOnly'), 'Must be HttpOnly');
  assert(cookieStr.includes('SameSite=Lax'), 'Must be SameSite=Lax');
  assert(cookieStr.includes('Path=/'), 'Must be Path=/');
  console.log('PASS: Initial request created valid session with HttpOnly, SameSite=Lax, Path=/');

  // Test 3: Session Persistence
  console.log('\n3. Testing Session Persistence with Cookie...');
  const cookieVal = cookieStr.split(';')[0];
  const secondRes = await request({
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/music/accounts',
    method: 'GET',
    headers: { 'Cookie': cookieVal }
  });
  assert.strictEqual(secondRes.statusCode, 200);
  assert(!secondRes.headers['set-cookie'], 'Persistent session must not re-issue Set-Cookie');
  console.log('PASS: Subsequent request maintained session without re-issuing cookie');

  // Test 4: Cookie Tamper Resistance
  console.log('\n4. Testing Cookie Tamper Resistance...');
  const tamperedCookie = cookieVal + 'tampered_bad_sig';
  const tamperedRes = await request({
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/music/accounts',
    method: 'GET',
    headers: { 'Cookie': tamperedCookie }
  });
  assert(tamperedRes.headers['set-cookie'], 'Tampered cookie must trigger new session creation');
  console.log('PASS: Tampered cookie was rejected and new valid session was issued');

  // Test 5: Account Isolation between Users
  console.log('\n5. Testing Account Isolation between Users...');
  // User A
  const userARes = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/music/accounts', method: 'GET' });
  const cookieA = (Array.isArray(userARes.headers['set-cookie']) ? userARes.headers['set-cookie'][0] : userARes.headers['set-cookie']).split(';')[0];
  
  // User B
  const userBRes = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/music/accounts', method: 'GET' });
  const cookieB = (Array.isArray(userBRes.headers['set-cookie']) ? userBRes.headers['set-cookie'][0] : userBRes.headers['set-cookie']).split(';')[0];

  // Extract raw user IDs by inspecting users table
  const { rows: users } = await pool.query('SELECT id FROM users ORDER BY created_at DESC LIMIT 2');
  const userIdA = users[1].id;
  const userIdB = users[0].id;

  // Insert mock account for User A
  const mockAccessTokenEnc = 'v1:mock_iv:mock_cipher:mock_tag';
  await pool.query(
    `INSERT INTO connected_accounts (id, user_id, provider, provider_account_id, access_token_enc, refresh_token_enc, expires_at, scopes, created_at, updated_at)
     VALUES ('acc_mock_a', $1, 'spotify', 'spotify_user_alpha', $2, $2, $3, 'read', $4, $4)`,
    [userIdA, mockAccessTokenEnc, Date.now() + 3600000, Date.now()]
  );

  // Query User A accounts
  const checkARes = await request({
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/music/accounts',
    method: 'GET',
    headers: { 'Cookie': cookieA }
  });
  const accountsA = JSON.parse(checkARes.body);

  // Query User B accounts
  const checkBRes = await request({
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/music/accounts',
    method: 'GET',
    headers: { 'Cookie': cookieB }
  });
  const accountsB = JSON.parse(checkBRes.body);

  assert(accountsA.some(a => a.providerAccountId === 'spotify_user_alpha'), 'User A must see their connected account');
  assert.strictEqual(accountsB.length, 0, 'User B must NOT see User A connected account');
  console.log('PASS: Account isolation verified — User A sees account, User B sees 0 accounts');

  // Test 6: Disconnect Behavior
  console.log('\n6. Testing Disconnect Provider Route...');
  const disconnRes = await request({
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/music/disconnect/spotify',
    method: 'POST',
    headers: { 'Cookie': cookieA }
  });
  assert.strictEqual(disconnRes.statusCode, 200);
  const disconnJson = JSON.parse(disconnRes.body);
  assert.strictEqual(disconnJson.success, true);

  const checkAfterDisconn = await request({
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/music/accounts',
    method: 'GET',
    headers: { 'Cookie': cookieA }
  });
  const accountsAfter = JSON.parse(checkAfterDisconn.body);
  assert.strictEqual(accountsAfter.length, 0, 'User A accounts must be empty after disconnect');
  console.log('PASS: Disconnect route deleted record and /accounts is now empty');

  // Test 7: OAuth State Generation
  console.log('\n7. Testing OAuth State Generation (/api/music/connect/spotify)...');
  const connectRes = await request({
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/music/connect/spotify',
    method: 'GET',
    headers: { 'Cookie': cookieA }
  });
  assert.strictEqual(connectRes.statusCode, 302, 'Should return redirect to provider');
  const location = connectRes.headers['location'];
  assert(location.includes('https://accounts.spotify.com/authorize'), 'Must redirect to Spotify auth');
  assert(location.includes('state='), 'Redirect must include state query param');

  const urlParams = new URLSearchParams(location.split('?')[1]);
  const generatedState = urlParams.get('state');
  const { rows: stateRows } = await pool.query('SELECT * FROM oauth_states WHERE state = $1', [generatedState]);
  assert.strictEqual(stateRows.length, 1, 'State must be stored in oauth_states table');
  console.log('PASS: OAuth state generated, stored in DB, and attached to redirect URL');

  // Cleanup
  await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userIdA, userIdB]);
  await pool.end();

  console.log('\n=== ALL NON-SPOTIFY RUNTIME VERIFICATIONS PASSED SUCCESSFULLY ===');
}

runRuntimeSuite().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
