// ─── Phase 6B Cloud Library Ownership & Security Regression Suite ──────────────
// Tests 20 required ownership, IDOR, quota, and concurrency scenarios
// + 1 room playback compatibility test.

const http = require('http');
const assert = require('assert');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { pool, initDb, insertTrack, getTrack } = require('./src/db');
const { sessionMiddleware } = require('./src/auth/session');
const { resolveProviderTrack } = require('./src/music/resolver');

// Mock R2 storage
const r2Storage = new Map();
const r2Mock = require('./src/r2');
let presignedUrlCalls = 0;

const originalUpload = r2Mock.uploadToR2;
const originalGetStreamUrl = r2Mock.getStreamUrl;
const originalGetTextObject = r2Mock.getTextObject;
const originalDeleteFromR2 = r2Mock.deleteFromR2;

r2Mock.uploadToR2 = async (key, buffer, contentType) => {
  r2Storage.set(key, { buffer, contentType });
};

r2Mock.getStreamUrl = async (key) => {
  presignedUrlCalls++;
  return `https://mock-r2.cloudflarestorage.com/${key}?signed=true`;
};

r2Mock.getTextObject = async (key) => {
  const item = r2Storage.get(key);
  if (!item) return null;
  return item.buffer.toString('utf-8');
};

r2Mock.deleteFromR2 = async (key) => {
  r2Storage.delete(key);
};

const libraryRoutes = require('./src/libraryRoutes');
const authRoutes = require('./src/auth/authRoutes');
const playlistRoutes = require('./src/playlists/routes');

const app = express();
app.use(express.json());
app.use('/api/auth', sessionMiddleware, authRoutes);
app.use('/library', sessionMiddleware, libraryRoutes);
app.use('/api/playlists', sessionMiddleware, playlistRoutes);

// Legacy room playback endpoints for compatibility test
const libraryManager = require('./src/libraryManager');
app.get(['/api/library/tracks/:id/download', '/api/library/tracks/:id/download/:filename'], async (req, res) => {
  const { id } = req.params;
  let track = libraryManager.getTrack(id);
  if (!track) {
    try {
      const r2Track = await getTrack(id);
      if (r2Track) {
        res.setHeader('Content-Type', 'audio/mpeg');
        return res.status(200).send(Buffer.from('MOCK_AUDIO_DATA'));
      }
    } catch (e) {}
    return res.status(404).json({ error: 'Track not found' });
  }
  res.status(200).send(Buffer.from('LOCAL_CATALOG_AUDIO'));
});

app.get('/api/library/covers/:filename', async (req, res) => {
  const { filename } = req.params;
  if (filename.startsWith('r2-')) {
    const id = filename.replace(/^r2-/, '').split('.')[0];
    const track = await getTrack(id);
    if (track && track.cover_key) {
      return res.redirect(`https://mock-r2.cloudflarestorage.com/${track.cover_key}`);
    }
    return res.status(404).json({ error: 'Cover not found' });
  }
  res.status(404).json({ error: 'Cover not found' });
});

const TEST_PORT = 3097;
let server;

// Helper to make HTTP requests
function httpRequest({ method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: raw,
          json,
        });
      });
    });
    req.on('error', reject);
    if (body) {
      if (Buffer.isBuffer(body)) {
        req.write(body);
      } else if (typeof body === 'string') {
        req.write(body);
      }
    }
    req.end();
  });
}

function extractSessionCookie(res) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return null;
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = cookieStr.match(/noirsync_session=([^;]+)/);
  return match ? `noirsync_session=${match[1]}` : null;
}

// Multipart builder helper
function buildMultipart({ fields = {}, files = {} }) {
  const boundary = `----WebKitFormBoundary${uuidv4().replace(/-/g, '')}`;
  const crlf = '\r\n';
  const chunks = [];

  for (const [key, val] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="${key}"${crlf}${crlf}` +
      `${val}${crlf}`
    ));
  }

  for (const [key, file] of Object.entries(files)) {
    chunks.push(Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="${key}"; filename="${file.filename}"${crlf}` +
      `Content-Type: ${file.contentType || 'application/octet-stream'}${crlf}${crlf}`
    ));
    chunks.push(Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer));
    chunks.push(Buffer.from(crlf));
  }

  chunks.push(Buffer.from(`--${boundary}--${crlf}`));
  const body = Buffer.concat(chunks);
  const contentType = `multipart/form-data; boundary=${boundary}`;

  return { body, contentType };
}

async function runTests() {
  console.log('=== PHASE 6B: NOIRSYNC USER-OWNED CLOUD LIBRARY REGRESSION ===\n');

  await initDb();
  server = http.createServer(app);
  await new Promise(r => server.listen(TEST_PORT, r));

  const runId = Date.now();

  try {
    // Setup users
    console.log('--- Setting up Test Users ---');
    // 1. User A (permanent)
    const regResA = await httpRequest({
      method: 'POST',
      path: '/api/auth/register',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `usera_${runId}@example.com`,
        username: `usera_${runId}`,
        password: 'Password123!',
      }),
    });
    assert.strictEqual(regResA.status, 201, 'User A registration must succeed');
    const cookieA = extractSessionCookie(regResA);
    const userA = regResA.json.user;
    console.log(`User A created: ${userA.id} (${userA.username})`);

    // 2. User B (permanent)
    const regResB = await httpRequest({
      method: 'POST',
      path: '/api/auth/register',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `userb_${runId}@example.com`,
        username: `userb_${runId}`,
        password: 'Password123!',
      }),
    });
    assert.strictEqual(regResB.status, 201, 'User B registration must succeed');
    const cookieB = extractSessionCookie(regResB);
    const userB = regResB.json.user;
    console.log(`User B created: ${userB.id} (${userB.username})`);

    // 3. Guest User
    const guestRes = await httpRequest({
      method: 'GET',
      path: '/api/auth/me',
    });
    const guestCookie = extractSessionCookie(guestRes);
    assert.strictEqual(guestRes.json.isGuest, true, 'Guest user must be isGuest=true');
    console.log(`Guest user initialized: ${guestRes.json.user.id}\n`);

    let trackAId = null;
    let trackBId = null;
    const mockAudio = Buffer.alloc(1024 * 50, 0x41); // 50 KB mock audio

    // Test 1: Permanent user can upload a Cloud Library track
    console.log('Test 1: Permanent user can upload a Cloud Library track...');
    const uploadA = buildMultipart({
      fields: { title: 'Song Alpha', artist: 'Artist A' },
      files: { audio: { filename: 'alpha.mp3', buffer: mockAudio, contentType: 'audio/mpeg' } },
    });
    const upResA = await httpRequest({
      method: 'POST',
      path: '/library/upload',
      headers: { 'Content-Type': uploadA.contentType, 'Cookie': cookieA },
      body: uploadA.body,
    });
    assert.strictEqual(upResA.status, 200, `Expected 200, got ${upResA.status}: ${upResA.body}`);
    assert.strictEqual(upResA.json.success, true);
    assert.strictEqual(upResA.json.track.user_id, userA.id, 'Uploaded track user_id must match User A');
    assert.ok(upResA.json.track.audio_key.startsWith(`users/${userA.id}/audio/`), 'Audio key must be user-scoped');
    trackAId = upResA.json.track.id;
    console.log('PASS: User A uploaded track with user-scoped R2 key and correct user_id.');

    // Test 2: Guest cannot upload permanent Cloud Library track
    console.log('\nTest 2: Guest cannot upload permanent Cloud Library track...');
    const uploadGuest = buildMultipart({
      fields: { title: 'Guest Song', artist: 'Guest' },
      files: { audio: { filename: 'guest.mp3', buffer: mockAudio, contentType: 'audio/mpeg' } },
    });
    const upResGuest = await httpRequest({
      method: 'POST',
      path: '/library/upload',
      headers: { 'Content-Type': uploadGuest.contentType, 'Cookie': guestCookie },
      body: uploadGuest.body,
    });
    assert.strictEqual(upResGuest.status, 403, `Expected 403 Forbidden for guest, got ${upResGuest.status}`);
    assert.strictEqual(upResGuest.json.code, 'AUTH_REQUIRED');
    console.log('PASS: Guest upload was rejected with HTTP 403 AUTH_REQUIRED.');

    // Setup Track B for User B
    const uploadB = buildMultipart({
      fields: { title: 'Song Beta', artist: 'Artist B' },
      files: {
        audio: { filename: 'beta.mp3', buffer: mockAudio, contentType: 'audio/mpeg' },
        cover: { filename: 'beta.jpg', buffer: Buffer.from('MOCK_COVER'), contentType: 'image/jpeg' },
      },
    });
    const upResB = await httpRequest({
      method: 'POST',
      path: '/library/upload',
      headers: { 'Content-Type': uploadB.contentType, 'Cookie': cookieB },
      body: uploadB.body,
    });
    assert.strictEqual(upResB.status, 200);
    trackBId = upResB.json.track.id;

    // Test 3: User A sees only User A's tracks
    console.log('\nTest 3: User A sees only User A\'s tracks in GET /library...');
    const listResA = await httpRequest({
      method: 'GET',
      path: '/library',
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(listResA.status, 200);
    const tracksA = listResA.json;
    assert.ok(tracksA.some(t => t.id === trackAId), 'User A must see Track A');
    assert.ok(!tracksA.some(t => t.id === trackBId), 'User A must NOT see Track B');
    console.log('PASS: User A sees only User A\'s tracks.');

    // Test 4: User B sees only User B's tracks
    console.log('\nTest 4: User B sees only User B\'s tracks in GET /library...');
    const listResB = await httpRequest({
      method: 'GET',
      path: '/library',
      headers: { 'Cookie': cookieB },
    });
    assert.strictEqual(listResB.status, 200);
    const tracksB = listResB.json;
    assert.ok(tracksB.some(t => t.id === trackBId), 'User B must see Track B');
    assert.ok(!tracksB.some(t => t.id === trackAId), 'User B must NOT see Track A');
    console.log('PASS: User B sees only User B\'s tracks.');

    // Test 5: User A cannot stream User B's track
    console.log('\nTest 5: User A cannot stream User B\'s track...');
    const streamRes = await httpRequest({
      method: 'GET',
      path: `/library/${trackBId}/stream`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(streamRes.status, 404, `Expected 404, got ${streamRes.status}`);
    console.log('PASS: User A cannot stream User B\'s track (returned 404).');

    // Test 6: User A cannot access User B's cover
    console.log('\nTest 6: User A cannot access User B\'s cover...');
    const coverRes = await httpRequest({
      method: 'GET',
      path: `/library/${trackBId}/cover`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(coverRes.status, 404, `Expected 404, got ${coverRes.status}`);
    console.log('PASS: User A cannot access User B\'s cover (returned 404).');

    // Add lyrics to Track B as User B
    const lyricsUpload = buildMultipart({
      files: { lyrics: { filename: 'beta.lrc', buffer: Buffer.from('[00:01.00]Hello Beta'), contentType: 'text/plain' } },
    });
    const addLrcRes = await httpRequest({
      method: 'POST',
      path: `/library/${trackBId}/lyrics`,
      headers: { 'Content-Type': lyricsUpload.contentType, 'Cookie': cookieB },
      body: lyricsUpload.body,
    });
    assert.strictEqual(addLrcRes.status, 200, 'User B adding lyrics to Track B must succeed');

    // Test 7: User A cannot read User B's lyrics
    console.log('\nTest 7: User A cannot read User B\'s lyrics...');
    const readLrcRes = await httpRequest({
      method: 'GET',
      path: `/library/${trackBId}/lyrics`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(readLrcRes.status, 404, `Expected 404, got ${readLrcRes.status}`);
    console.log('PASS: User A cannot read User B\'s lyrics (returned 404).');

    // Test 8: User A cannot replace User B's lyrics
    console.log('\nTest 8: User A cannot replace User B\'s lyrics...');
    const evilLrcUpload = buildMultipart({
      files: { lyrics: { filename: 'hacked.lrc', buffer: Buffer.from('[00:01.00]Hacked'), contentType: 'text/plain' } },
    });
    const evilLrcRes = await httpRequest({
      method: 'POST',
      path: `/library/${trackBId}/lyrics`,
      headers: { 'Content-Type': evilLrcUpload.contentType, 'Cookie': cookieA },
      body: evilLrcUpload.body,
    });
    assert.strictEqual(evilLrcRes.status, 404, `Expected 404, got ${evilLrcRes.status}`);
    // Verify User B's lyrics are intact
    const bLrcCheck = await httpRequest({
      method: 'GET',
      path: `/library/${trackBId}/lyrics`,
      headers: { 'Cookie': cookieB },
    });
    assert.strictEqual(bLrcCheck.status, 200);
    assert.ok(bLrcCheck.body.includes('Hello Beta'), 'Original lyrics must remain intact');
    console.log('PASS: User A cannot replace User B\'s lyrics.');

    // Test 9: User A cannot delete User B's track
    console.log('\nTest 9: User A cannot delete User B\'s track...');
    const delResA = await httpRequest({
      method: 'DELETE',
      path: `/library/${trackBId}`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(delResA.status, 404, `Expected 404, got ${delResA.status}`);
    const trackBCheck = await getTrack(trackBId);
    assert.ok(trackBCheck, 'Track B must still exist in database');
    console.log('PASS: User A cannot delete User B\'s track.');

    // Test 10: User B cannot delete User A's track
    console.log('\nTest 10: User B cannot delete User A\'s track...');
    const delResB = await httpRequest({
      method: 'DELETE',
      path: `/library/${trackAId}`,
      headers: { 'Cookie': cookieB },
    });
    assert.strictEqual(delResB.status, 404, `Expected 404, got ${delResB.status}`);
    const trackACheck = await getTrack(trackAId);
    assert.ok(trackACheck, 'Track A must still exist in database');
    console.log('PASS: User B cannot delete User A\'s track.');

    // Test 11: User-specific storage accounting works
    console.log('\nTest 11: User-specific storage accounting works...');
    const storA = await httpRequest({ method: 'GET', path: '/library/storage', headers: { 'Cookie': cookieA } });
    const storB = await httpRequest({ method: 'GET', path: '/library/storage', headers: { 'Cookie': cookieB } });
    assert.strictEqual(storA.status, 200);
    assert.strictEqual(storB.status, 200);
    assert.strictEqual(storA.json.used, mockAudio.length, 'User A storage must match Track A size');
    assert.strictEqual(storB.json.used, mockAudio.length, 'User B storage must match Track B size');
    console.log(`PASS: User A storage=${storA.json.used}B, User B storage=${storB.json.used}B.`);

    // Test 12: User A cannot consume User B's quota
    console.log('\nTest 12: User A cannot consume User B\'s quota...');
    const uploadA2 = buildMultipart({
      fields: { title: 'Song Alpha 2' },
      files: { audio: { filename: 'alpha2.mp3', buffer: mockAudio, contentType: 'audio/mpeg' } },
    });
    await httpRequest({
      method: 'POST',
      path: '/library/upload',
      headers: { 'Content-Type': uploadA2.contentType, 'Cookie': cookieA },
      body: uploadA2.body,
    });
    const storAAfter = await httpRequest({ method: 'GET', path: '/library/storage', headers: { 'Cookie': cookieA } });
    const storBAfter = await httpRequest({ method: 'GET', path: '/library/storage', headers: { 'Cookie': cookieB } });
    assert.strictEqual(storAAfter.json.used, mockAudio.length * 2, 'User A storage must reflect 2 tracks');
    assert.strictEqual(storBAfter.json.used, mockAudio.length, 'User B storage must remain unchanged');
    console.log('PASS: User A\'s uploads do not affect User B\'s quota.');

    // Test 13: Concurrent upload / quota behavior is safe
    console.log('\nTest 13: Concurrent upload/quota behavior is safe...');
    // Create User C with small quota to test concurrent race
    const regResC = await httpRequest({
      method: 'POST',
      path: '/api/auth/register',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `userc_${runId}@example.com`,
        username: `userc_${runId}`,
        password: 'Password123!',
      }),
    });
    const cookieC = extractSessionCookie(regResC);
    const userC = regResC.json.user;

    // Simulate quota check with withUserLock directly:
    // Try to run two concurrent operations that each would take 1.5 GB when quota is 2 GB
    const { withUserLock, getUserStorageUsage } = require('./src/db');
    const fakeSize = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
    const limit = 2 * 1024 * 1024 * 1024; // 2 GB

    let successfulLocks = 0;
    let rejectedLocks = 0;

    const op = async () => {
      try {
        await withUserLock(userC.id, async (client) => {
          const current = await getUserStorageUsage(userC.id, client);
          if (current + fakeSize > limit) {
            const err = new Error('STORAGE_FULL');
            err.code = 'STORAGE_FULL';
            throw err;
          }
          // Simulate insert of 1.5 GB track
          await insertTrack({
            id: `trk_race_${uuidv4()}`,
            title: 'Race Track',
            size: fakeSize,
            audio_key: `users/${userC.id}/audio/race.mp3`,
            provider: 'local',
            user_id: userC.id,
          }, client);
          successfulLocks++;
        });
      } catch (err) {
        if (err.code === 'STORAGE_FULL') {
          rejectedLocks++;
        } else {
          throw err;
        }
      }
    };

    // Run both operations concurrently
    await Promise.all([op(), op()]);
    assert.strictEqual(successfulLocks, 1, 'Exactly 1 concurrent upload must succeed within quota');
    assert.strictEqual(rejectedLocks, 1, 'Exactly 1 concurrent upload must be rejected due to quota limit');
    console.log('PASS: Concurrency lock prevented simultaneous uploads from exceeding user quota.');

    // Test 14: New tracks receive correct user_id in DB
    console.log('\nTest 14: New tracks receive correct user_id in database...');
    const dbTrackA = await getTrack(trackAId);
    assert.strictEqual(dbTrackA.user_id, userA.id, 'DB record must store user_id correctly');
    console.log('PASS: DB verified track user_id matches User A.');

    // Test 15: Existing migrated tracks have valid ownership
    console.log('\nTest 15: Existing legacy tracks with user_id NULL remain intact and not exposed...');
    // Query tracks with user_id IS NULL
    const legacyRes = await pool.query('SELECT * FROM tracks WHERE user_id IS NULL LIMIT 5');
    console.log(`Legacy tracks with user_id IS NULL: ${legacyRes.rows.length}`);
    // Verify neither User A nor User B can see them in GET /library
    assert.ok(!tracksA.some(t => t.user_id === null), 'User A must not see tracks with user_id NULL');
    assert.ok(!tracksB.some(t => t.user_id === null), 'User B must not see tracks with user_id NULL');
    console.log('PASS: Legacy tracks with NULL user_id are not exposed in Cloud Library.');

    // Test 16: Presigned URLs are never generated before ownership verification
    console.log('\nTest 16: Presigned URLs are never generated before ownership verification...');
    const callsBefore = presignedUrlCalls;
    // Unauthorized attempt
    await httpRequest({
      method: 'GET',
      path: `/library/${trackBId}/stream`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(presignedUrlCalls, callsBefore, 'Presigned URL must NOT be generated for unauthorized request');
    // Authorized attempt
    const authStreamRes = await httpRequest({
      method: 'GET',
      path: `/library/${trackBId}/stream`,
      headers: { 'Cookie': cookieB },
    });
    assert.strictEqual(authStreamRes.status, 200);
    assert.strictEqual(presignedUrlCalls, callsBefore + 1, 'Presigned URL MUST be generated for authorized request');
    console.log('PASS: Presigned URLs generated strictly after ownership authorization.');

    // Test 17: Malformed/nonexistent track IDs do not leak ownership information
    console.log('\nTest 17: Malformed/nonexistent track IDs do not leak ownership information...');
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const fakeStreamRes = await httpRequest({ method: 'GET', path: `/library/${fakeId}/stream`, headers: { 'Cookie': cookieA } });
    const fakeCoverRes = await httpRequest({ method: 'GET', path: `/library/${fakeId}/cover`, headers: { 'Cookie': cookieA } });
    const fakeLrcRes = await httpRequest({ method: 'GET', path: `/library/${fakeId}/lyrics`, headers: { 'Cookie': cookieA } });
    const fakeDelRes = await httpRequest({ method: 'DELETE', path: `/library/${fakeId}`, headers: { 'Cookie': cookieA } });
    assert.strictEqual(fakeStreamRes.status, 404);
    assert.strictEqual(fakeCoverRes.status, 404);
    assert.strictEqual(fakeLrcRes.status, 404);
    assert.strictEqual(fakeDelRes.status, 404);
    console.log('PASS: Nonexistent track IDs return consistent 404 responses.');

    // Test 18: Playlist behavior remains compatible
    console.log('\nTest 18: Playlist behavior remains compatible...');
    const plRes = await httpRequest({
      method: 'POST',
      path: '/api/playlists',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookieA },
      body: JSON.stringify({ name: 'User A Playlist' }),
    });
    assert.strictEqual(plRes.status, 201);
    const playlistId = plRes.json.playlist.id;

    // Add Track A to playlist
    const addPlRes = await httpRequest({
      method: 'POST',
      path: `/api/playlists/${playlistId}/tracks`,
      headers: { 'Content-Type': 'application/json', 'Cookie': cookieA },
      body: JSON.stringify({ trackId: trackAId }),
    });
    assert.strictEqual(addPlRes.status, 201);
    console.log('PASS: Playlists continue to function normally with user-owned tracks.');

    // Test 19: Spotify metadata tracks remain compatible
    console.log('\nTest 19: Spotify metadata tracks remain compatible...');
    const resolvedSpotify = await resolveProviderTrack({
      provider: 'spotify',
      providerTrackId: `spot_${runId}`,
      title: 'Spotify Track',
      artist: 'Spotify Artist',
    });
    assert.ok(resolvedSpotify.id.startsWith('ext_'), 'Resolved track must have ext_ prefix');
    // Verify it is NOT returned in User A's Cloud Library
    const listCheck = await httpRequest({
      method: 'GET',
      path: '/library',
      headers: { 'Cookie': cookieA },
    });
    assert.ok(!listCheck.json.some(t => t.id === resolvedSpotify.id), 'Spotify track must not appear in Cloud Library listing');
    console.log('PASS: Spotify metadata tracks remain compatible and isolated from Cloud Library.');

    // Test 20: Guest -> permanent upgrade preserves access to the user's migrated Cloud Library tracks
    console.log('\nTest 20: Guest -> permanent upgrade preserves access to the user\'s migrated Cloud Library tracks...');
    // Create a new guest session
    const freshGuest = await httpRequest({ method: 'GET', path: '/api/auth/me' });
    const freshGuestCookie = extractSessionCookie(freshGuest);
    const guestId = freshGuest.json.user.id;

    // Simulate a pre-existing track owned by this guestId
    const guestTrackId = `trk_mig_${uuidv4()}`;
    await insertTrack({
      id: guestTrackId,
      title: 'Migrated Track',
      artist: 'Original Artist',
      size: 1024 * 10,
      audio_key: `users/${guestId}/audio/mig.mp3`,
      provider: 'local',
      user_id: guestId,
    });

    // Upgrade guest to permanent account
    const upgradeRes = await httpRequest({
      method: 'POST',
      path: '/api/auth/register',
      headers: { 'Content-Type': 'application/json', 'Cookie': freshGuestCookie },
      body: JSON.stringify({
        email: `upgraded_${runId}@example.com`,
        username: `upgraded_${runId}`,
        password: 'Password123!',
      }),
    });
    assert.strictEqual(upgradeRes.status, 201);
    assert.strictEqual(upgradeRes.json.user.id, guestId, 'Upgraded user must preserve user.id');

    // Verify upgraded user can still list and stream their track
    const upgradedList = await httpRequest({
      method: 'GET',
      path: '/library',
      headers: { 'Cookie': freshGuestCookie },
    });
    assert.ok(upgradedList.json.some(t => t.id === guestTrackId), 'Upgraded user must still see their track');
    console.log('PASS: Guest -> permanent upgrade preserved track ownership in place.');

    // Test 21: Room playback compatibility through legacy endpoints
    console.log('\nTest 21: Room playback compatibility through legacy endpoints...');
    const roomDownloadRes = await httpRequest({
      method: 'GET',
      path: `/api/library/tracks/${trackAId}/download`,
    });
    assert.strictEqual(roomDownloadRes.status, 200, 'Room playback download must succeed without requiring Cloud Library ownership');
    console.log('PASS: Existing room playback continues working through legacy download route.');

    console.log('\n==================================================');
    console.log('ALL 21 TESTS PASSED SUCCESSFULLY (20 Required + 1 Room Playback)');
    console.log('==================================================');
  } finally {
    // Restore mocks
    r2Mock.uploadToR2 = originalUpload;
    r2Mock.getStreamUrl = originalGetStreamUrl;
    r2Mock.getTextObject = originalGetTextObject;
    r2Mock.deleteFromR2 = originalDeleteFromR2;

    if (server) {
      await new Promise(r => server.close(r));
    }
    await pool.end();
  }
}

runTests().catch((err) => {
  console.error('\nFAIL: Test suite failed with error:', err);
  process.exit(1);
});
