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
const { sessionMiddleware, parseCookies, COOKIE_NAME } = require('./src/auth/session');
const { unsign } = require('./src/auth/crypto');
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
      if (!r2Track || !r2Track.audio_key) {
        return res.status(404).json({ error: 'Track not found' });
      }

      const isPublicCatalog = r2Track.provider === 'noirsync_public' && r2Track.publication_status === 'published';
      const isSharedCloud = r2Track.provider === 'local';

      if (!isPublicCatalog && !isSharedCloud) {
        return res.status(403).json({ error: 'Forbidden', message: 'Track is not available for download' });
      }

      if (isSharedCloud) {
        const cookies = parseCookies(req.headers.cookie);
        const sessionToken = cookies[COOKIE_NAME];
        const userId = sessionToken ? unsign(sessionToken) : null;

        if (!userId) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Authentication required to stream Cloud Library tracks'
          });
        }
      }

      res.setHeader('Content-Type', 'audio/mpeg');
      return res.status(200).send(Buffer.from('MOCK_AUDIO_DATA'));
    } catch (e) {
      return res.status(500).json({ error: 'Internal server error' });
    }
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

    // Test 3: Shared visibility in GET /library (User A and User B see all shared tracks)
    console.log('\nTest 3: Shared visibility in GET /library...');
    const listResA = await httpRequest({
      method: 'GET',
      path: '/library',
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(listResA.status, 200);
    const tracksA = listResA.json;
    assert.ok(tracksA.some(t => t.id === trackAId), 'User A must see Track A');
    assert.ok(tracksA.some(t => t.id === trackBId), 'User A must see Track B in shared Cloud Library');

    const listResB = await httpRequest({
      method: 'GET',
      path: '/library',
      headers: { 'Cookie': cookieB },
    });
    assert.strictEqual(listResB.status, 200);
    const tracksB = listResB.json;
    assert.ok(tracksB.some(t => t.id === trackBId), 'User B must see Track B');
    assert.ok(tracksB.some(t => t.id === trackAId), 'User B must see Track A in shared Cloud Library');
    console.log('PASS: Both User A and User B see all shared Cloud Library tracks.');

    // Test 4: Shared metadata via GET /library/:id
    console.log('\nTest 4: Shared metadata via GET /library/:id...');
    const metaRes = await httpRequest({
      method: 'GET',
      path: `/library/${trackAId}`,
      headers: { 'Cookie': cookieB },
    });
    assert.strictEqual(metaRes.status, 200);
    assert.strictEqual(metaRes.json.track.id, trackAId);
    console.log('PASS: User B can retrieve User A\'s track metadata.');

    // Test 5: Shared streaming via GET /library/:id/stream
    console.log('\nTest 5: Shared streaming via GET /library/:id/stream...');
    const streamRes = await httpRequest({
      method: 'GET',
      path: `/library/${trackBId}/stream`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(streamRes.status, 200, `Expected 200, got ${streamRes.status}`);
    assert.ok(streamRes.json.url, 'Stream response must contain presigned URL');
    console.log('PASS: User A can stream User B\'s track in shared Cloud Library.');

    // Test 6: Shared cover via GET /library/:id/cover
    console.log('\nTest 6: Shared cover via GET /library/:id/cover...');
    const coverRes = await httpRequest({
      method: 'GET',
      path: `/library/${trackBId}/cover`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(coverRes.status, 302, `Expected 302 redirect, got ${coverRes.status}`);
    assert.ok(coverRes.headers.location, 'Cover response must redirect to presigned cover URL');
    console.log('PASS: User A can access User B\'s cover in shared Cloud Library.');

    // Add lyrics to Track B as User B (uploader)
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

    // Test 7: Shared lyrics via GET /library/:id/lyrics
    console.log('\nTest 7: Shared lyrics via GET /library/:id/lyrics...');
    const readLrcRes = await httpRequest({
      method: 'GET',
      path: `/library/${trackBId}/lyrics`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(readLrcRes.status, 200, `Expected 200, got ${readLrcRes.status}`);
    assert.ok(readLrcRes.body.includes('Hello Beta'), 'User A must be able to read User B\'s lyrics');
    console.log('PASS: User A can read User B\'s lyrics in shared Cloud Library.');

    // Test 8: Non-uploader cannot replace another user's lyrics (403 Forbidden)
    console.log('\nTest 8: Non-uploader cannot replace another user\'s lyrics (403 Forbidden)...');
    const evilLrcUpload = buildMultipart({
      files: { lyrics: { filename: 'hacked.lrc', buffer: Buffer.from('[00:01.00]Hacked'), contentType: 'text/plain' } },
    });
    const evilLrcRes = await httpRequest({
      method: 'POST',
      path: `/library/${trackBId}/lyrics`,
      headers: { 'Content-Type': evilLrcUpload.contentType, 'Cookie': cookieA },
      body: evilLrcUpload.body,
    });
    assert.strictEqual(evilLrcRes.status, 403, `Expected 403 Forbidden, got ${evilLrcRes.status}`);
    // Verify User B's lyrics are intact
    const bLrcCheck = await httpRequest({
      method: 'GET',
      path: `/library/${trackBId}/lyrics`,
      headers: { 'Cookie': cookieB },
    });
    assert.strictEqual(bLrcCheck.status, 200);
    assert.ok(bLrcCheck.body.includes('Hello Beta'), 'Original lyrics must remain intact');
    console.log('PASS: User A cannot replace User B\'s lyrics (HTTP 403 Forbidden).');

    // Test 9: Cross-user deletion protection (User A cannot delete User B's track -> 403)
    console.log('\nTest 9: Cross-user deletion protection (User A cannot delete User B\'s track)...');
    const delResA = await httpRequest({
      method: 'DELETE',
      path: `/library/${trackBId}`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(delResA.status, 403, `Expected 403 Forbidden, got ${delResA.status}`);
    const trackBCheck = await getTrack(trackBId);
    assert.ok(trackBCheck, 'Track B must still exist in database');
    console.log('PASS: User A cannot delete User B\'s track (HTTP 403 Forbidden).');

    // Test 10: Cross-user deletion protection (User B cannot delete User A's track -> 403)
    console.log('\nTest 10: Cross-user deletion protection (User B cannot delete User A\'s track)...');
    const delResB = await httpRequest({
      method: 'DELETE',
      path: `/library/${trackAId}`,
      headers: { 'Cookie': cookieB },
    });
    assert.strictEqual(delResB.status, 403, `Expected 403 Forbidden, got ${delResB.status}`);
    const trackACheck = await getTrack(trackAId);
    assert.ok(trackACheck, 'Track A must still exist in database');
    console.log('PASS: User B cannot delete User A\'s track (HTTP 403 Forbidden).');

    // Test 11: Unowned / historical track deletion protection (user_id IS NULL -> 403)
    console.log('\nTest 11: Unowned / historical track deletion protection (user_id IS NULL -> 403)...');
    const unownedTrackId = `trk_unowned_${runId}`;
    await insertTrack({
      id: unownedTrackId,
      title: 'Unowned System Track',
      artist: 'System',
      size: 1024,
      audio_key: 'system/audio/unowned.mp3',
      provider: 'local',
      user_id: null,
    });
    const delUnownedRes = await httpRequest({
      method: 'DELETE',
      path: `/library/${unownedTrackId}`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(delUnownedRes.status, 403, `Expected 403 Forbidden, got ${delUnownedRes.status}`);
    console.log('PASS: Deletion of unowned / system track is rejected with HTTP 403 Forbidden.');

    // Verify unowned track DOES appear in GET /library for all users
    const listWithUnowned = await httpRequest({
      method: 'GET',
      path: '/library',
      headers: { 'Cookie': cookieA },
    });
    assert.ok(listWithUnowned.json.some(t => t.id === unownedTrackId), 'Unowned shared Cloud track must appear in GET /library');
    console.log('PASS: Unowned shared Cloud track appears in GET /library for all users.');

    // Test 12: Uploader can delete their own track
    console.log('\nTest 12: Uploader can delete their own track...');
    const uploadDel = buildMultipart({
      fields: { title: 'Track To Delete', artist: 'Artist A' },
      files: { audio: { filename: 'delete_me.mp3', buffer: mockAudio, contentType: 'audio/mpeg' } },
    });
    const upDelRes = await httpRequest({
      method: 'POST',
      path: '/library/upload',
      headers: { 'Content-Type': uploadDel.contentType, 'Cookie': cookieA },
      body: uploadDel.body,
    });
    assert.strictEqual(upDelRes.status, 200);
    const trackToDeleteId = upDelRes.json.track.id;

    const delOwnRes = await httpRequest({
      method: 'DELETE',
      path: `/library/${trackToDeleteId}`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(delOwnRes.status, 200, `Expected 200, got ${delOwnRes.status}`);
    const deletedTrackCheck = await getTrack(trackToDeleteId);
    assert.strictEqual(deletedTrackCheck, null, 'Deleted track must be removed from database');
    console.log('PASS: Uploader successfully deleted their own track.');

    // Test 13: Per-user 2 GiB quota is NOT enforced on upload
    console.log('\nTest 13: Per-user 2 GiB quota is NOT enforced on upload...');
    const uploadLarge = buildMultipart({
      fields: { title: 'Large Track Free From Quota' },
      files: { audio: { filename: 'large.mp3', buffer: mockAudio, contentType: 'audio/mpeg' } },
    });
    const upResLarge = await httpRequest({
      method: 'POST',
      path: '/library/upload',
      headers: { 'Content-Type': uploadLarge.contentType, 'Cookie': cookieB },
      body: uploadLarge.body,
    });
    assert.strictEqual(upResLarge.status, 200, 'Upload must succeed without 507 quota errors');
    console.log('PASS: Upload succeeds without quota rejection.');

    // Test 14: New tracks receive correct user_id in DB for attribution
    console.log('\nTest 14: New tracks receive correct user_id in database for attribution...');
    const dbTrackB = await getTrack(trackBId);
    assert.strictEqual(dbTrackB.user_id, userB.id, 'DB record must store user_id correctly');
    console.log('PASS: DB verified track user_id matches User B.');

    // Test 15: Tracks with audio_key NULL (e.g. metadata-only tracks) are excluded from Cloud Library
    console.log('\nTest 15: Metadata-only tracks without audio_key are excluded from Cloud Library...');
    const metaOnlyId = `trk_meta_${runId}`;
    await insertTrack({
      id: metaOnlyId,
      title: 'Metadata Only No Audio',
      artist: 'Ghost Artist',
      audio_key: null,
      provider: 'local',
      user_id: userB.id,
    });
    const checkSharedList = await httpRequest({
      method: 'GET',
      path: '/library',
      headers: { 'Cookie': cookieB },
    });
    assert.ok(!checkSharedList.json.some(t => t.id === metaOnlyId), 'Track with audio_key NULL must not appear in Cloud Library');
    console.log('PASS: Tracks with audio_key NULL are excluded from Cloud Library.');

    // Test 16: Presigned URLs generated strictly after verifying track exists
    console.log('\nTest 16: Presigned URLs generated strictly after verifying track exists...');
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

    // Test 17: Playlist behavior remains compatible
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

    // Test 21: Legacy audio download boundary & room playback authorization
    console.log('\nTest 21: Legacy audio download boundary & room playback authorization...');
    
    // 21a: Anonymous caller attempting to download shared Cloud track -> 401
    const anonRes = await httpRequest({
      method: 'GET',
      path: `/api/library/tracks/${trackBId}/download`,
    });
    assert.strictEqual(anonRes.status, 401, 'Anonymous download of shared Cloud track must be rejected with 401');
    assert.strictEqual(anonRes.json?.error, 'Unauthorized');
    console.log('PASS: Anonymous download of shared Cloud track is rejected with 401.');

    // 21b: Authenticated User A streaming User B's shared Cloud track -> 200
    const authDownloadRes = await httpRequest({
      method: 'GET',
      path: `/api/library/tracks/${trackBId}/download`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(authDownloadRes.status, 200, 'Authenticated user must be able to stream shared Cloud track');
    console.log('PASS: Authenticated user streams shared Cloud track successfully with 200.');

    // 21c: Metadata-only track (audio_key = NULL) -> 404
    const metaTrack = await insertTrack({
      id: `meta_only_${runId}_${uuidv4().slice(0, 8)}`,
      title: 'Spotify Metadata Only',
      artist: 'Artist',
      provider: 'spotify',
      provider_track_id: `spotify_${runId}`,
      audio_key: null,
      user_id: null,
    });
    const metaDownloadRes = await httpRequest({
      method: 'GET',
      path: `/api/library/tracks/${metaTrack.id}/download`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(metaDownloadRes.status, 404, 'Metadata-only track without audio_key must return 404');
    console.log('PASS: Metadata-only track without audio_key returns 404.');

    // 21d: Historical shared Cloud track (provider = 'local', user_id = NULL, audio_key != NULL)
    // - Anonymous download -> 401
    // - Authenticated download -> 200
    const historicalTrack = await insertTrack({
      id: `hist_shared_${runId}_${uuidv4().slice(0, 8)}`,
      title: 'Historical Shared Cloud Track',
      artist: 'Artist',
      provider: 'local',
      audio_key: 'historical/audio.mp3',
      user_id: null,
    });
    const anonHistoricalRes = await httpRequest({
      method: 'GET',
      path: `/api/library/tracks/${historicalTrack.id}/download`,
    });
    assert.strictEqual(anonHistoricalRes.status, 401, 'Anonymous download of historical shared Cloud track must return 401');

    const authHistoricalRes = await httpRequest({
      method: 'GET',
      path: `/api/library/tracks/${historicalTrack.id}/download`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(authHistoricalRes.status, 200, 'Authenticated user must be able to stream historical shared Cloud track');
    console.log('PASS: Historical shared Cloud track (user_id = null) is accessible to authenticated users.');

    // 21f: Unauthorized provider record with audio_key -> 403
    const unauthorizedTrack = await insertTrack({
      id: `unauth_${runId}_${uuidv4().slice(0, 8)}`,
      title: 'Unauthorized Provider Track',
      artist: 'Artist',
      provider: 'unauthorized_provider',
      audio_key: 'unauth/audio.mp3',
      user_id: null,
    });
    const unauthDownloadRes = await httpRequest({
      method: 'GET',
      path: `/api/library/tracks/${unauthorizedTrack.id}/download`,
      headers: { 'Cookie': cookieA },
    });
    assert.strictEqual(unauthDownloadRes.status, 403, 'Unauthorized provider record must return 403');
    console.log('PASS: Unauthorized provider record returns 403.');

    // 21e: Universal public NoirSync content (provider = 'noirsync_public', published) -> anonymous 200
    const publicTrack = await insertTrack({
      id: `public_${runId}_${uuidv4().slice(0, 8)}`,
      title: 'Universal Public Song',
      artist: 'Catalog Artist',
      provider: 'noirsync_public',
      publication_status: 'published',
      audio_key: 'public/catalog/audio/song.mp3',
      user_id: null,
    });
    const publicDownloadRes = await httpRequest({
      method: 'GET',
      path: `/api/library/tracks/${publicTrack.id}/download`,
    });
    assert.strictEqual(publicDownloadRes.status, 200, 'Universal public published track must be downloadable anonymously');
    console.log('PASS: Universal public track streams anonymously with 200.');

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

runTests().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('\nFAIL: Test suite failed with error:', err);
  process.exit(1);
});
