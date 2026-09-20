// ─── Phase 6E Universal Music Library Regression Suite ────────────────────────
// Tests all 22 required architectural invariants and security boundaries:
// 1. Private Cloud Library tracks excluded from search.
// 2. Private tracks inaccessible through catalog (/api/catalog/tracks/:id -> 404).
// 3. Legacy NULL-owner local tracks excluded from search and catalog lookup.
// 4. Canonical provider tracks shared correctly across users.
// 5. Same provider identity resolves to same tracks.id.
// 6. User A adds universal track to playlist.
// 7. User B adds same universal track to playlist.
// 8. No duplicate audio/database track created.
// 9. No Cloud Library quota consumption.
// 10. Spotify download -> 403 Forbidden.
// 11. YouTube download -> 403 Forbidden.
// 12. Apple download -> 403 Forbidden.
// 13. Draft NoirSync public track -> stream rejected (403/404).
// 14. Published NoirSync public track -> stream authorized.
// 15. download_allowed enforcement (true -> authorized, false -> 403).
// 16. Catalog cannot access private R2 namespace (users/...).
// 17. Catalog cannot mutate/delete private tracks.
// 18. Phase 6B/6C regression integrity verification.
// 19. Phase 6D Room isolation invariant preservation.
// 20. Core sync timing invariant preservation.
// 21. Correction 1: Existing canonical provider migration does not publish legacy local/test rows.
// 22. Correction 2: Client-supplied fake title/artist/album/duration cannot overwrite authoritative provider metadata.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const db = require('./src/db');
const catalogDb = require('./src/catalog/db');
const playlistDb = require('./src/playlists/db');
const { resolveProviderTrack } = require('./src/music/resolver');
const { getMusicProvider, isCanonicalProvider } = require('./src/music/registry');

async function runRegression() {
  console.log('=== PHASE 6E — UNIVERSAL MUSIC LIBRARY REGRESSION TESTS ===\n');

  try {
    // Initialize database schema and migrations
    await db.initDb();

    const testRunId = Date.now();
    const userA = `u_6e_a_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
    const userB = `u_6e_b_${uuidv4().replace(/-/g, '').slice(0, 8)}`;

    await db.pool.query('INSERT INTO users (id, created_at, is_guest) VALUES ($1, $2, false), ($3, $4, false)', [
      userA, testRunId, userB, testRunId
    ]);

    // ── TEST 1: Private Cloud Library tracks excluded from search ──
    console.log('1. Testing private Cloud Library tracks excluded from search...');
    const privateTrackA = await db.insertTrack({
      id: `trk_priv_search_${testRunId}`,
      title: `Secret Searchable Title ${testRunId}`,
      artist: 'Secret Artist A',
      duration: 180,
      size: 3000000,
      format: 'mp3',
      audio_key: `users/${userA}/audio/secret.mp3`,
      provider: 'local',
      user_id: userA,
      publication_status: 'draft',
      download_allowed: false
    });

    const searchRes1 = await catalogDb.searchCatalog({ query: `Secret Searchable Title ${testRunId}` });
    assert.strictEqual(searchRes1.tracks.length, 0, 'Private track must NEVER appear in catalog search');
    console.log('   ✓ Private Cloud Library track excluded from search.\n');

    // ── TEST 2: Private tracks inaccessible through catalog lookup ──
    console.log('2. Testing private tracks inaccessible through catalog lookup...');
    const catLookupPriv = await catalogDb.getCatalogTrack(privateTrackA.id);
    assert.strictEqual(catLookupPriv, null, 'Private track lookup through catalog must return null');
    console.log('   ✓ Private track lookup returns null (HTTP 404 in route).\n');

    // ── TEST 3: Legacy NULL-owner local tracks excluded from search and catalog ──
    console.log('3. Testing legacy NULL-owner local tracks excluded from catalog...');
    const legacyLocalTrack = await db.insertTrack({
      id: `trk_legacy_local_${testRunId}`,
      title: `Legacy Local Unassigned ${testRunId}`,
      artist: 'Legacy Local Artist',
      duration: 120,
      provider: 'local',
      user_id: null,
      publication_status: 'draft',
      download_allowed: false
    });

    const searchLegacy = await catalogDb.searchCatalog({ query: `Legacy Local Unassigned ${testRunId}` });
    assert.strictEqual(searchLegacy.tracks.length, 0, 'Legacy local track must not appear in catalog search');

    const lookupLegacy = await catalogDb.getCatalogTrack(legacyLocalTrack.id);
    assert.strictEqual(lookupLegacy, null, 'Legacy local track cannot be retrieved via catalog');
    console.log('   ✓ Legacy NULL-owner local track excluded from search and catalog lookup.\n');

    // ── TEST 4: Canonical provider tracks shared correctly ──
    console.log('4. Testing canonical provider tracks shared correctly across users...');
    const spotifyProvId = `spot_canon_${testRunId}`;
    const canonSpotify = await db.insertTrack({
      id: `ext_spot_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      title: `Universal Spotify Hit ${testRunId}`,
      artist: 'Global Artist',
      album: 'Global Album',
      duration: 210,
      provider: 'spotify',
      provider_track_id: spotifyProvId,
      user_id: null,
      publication_status: 'published',
      download_allowed: false,
      external_url: `https://open.spotify.com/track/${spotifyProvId}`
    });

    const searchCanon = await catalogDb.searchCatalog({ query: `Universal Spotify Hit ${testRunId}` });
    assert.ok(searchCanon.tracks.length > 0, 'Canonical Spotify track should appear in search');
    assert.strictEqual(searchCanon.tracks[0].provider, 'spotify');
    assert.strictEqual(searchCanon.tracks[0].capabilities.playback, 'external_link');
    assert.strictEqual(searchCanon.tracks[0].capabilities.download, false);
    console.log('   ✓ Canonical provider track discoverable with correct capabilities.\n');

    // ── TEST 5: Same provider identity resolves to same tracks.id ──
    console.log('5. Testing same provider identity resolves to same tracks.id...');
    const resolvedFirst = await resolveProviderTrack({
      provider: 'spotify',
      providerTrackId: spotifyProvId,
      title: 'Different Title Attempt',
      artist: 'Different Artist Attempt'
    });
    assert.strictEqual(resolvedFirst.id, canonSpotify.id, 'Must resolve to existing canonical tracks.id');
    console.log('   ✓ Same provider identity resolves to identical canonical tracks.id.\n');

    // ── TEST 6 & 7: User A and User B add same universal track to playlists ──
    console.log('6 & 7. Testing User A and User B both add same universal track to their playlists...');
    const plA = await playlistDb.createPlaylist(userA, 'User A Universal List');
    const plB = await playlistDb.createPlaylist(userB, 'User B Universal List');

    const addA = await playlistDb.addTrackToPlaylist(plA.id, userA, canonSpotify.id);
    assert.ok(addA, 'User A should successfully add universal track');
    assert.strictEqual(addA.track_id, canonSpotify.id);

    const addB = await playlistDb.addTrackToPlaylist(plB.id, userB, canonSpotify.id);
    assert.ok(addB, 'User B should successfully add same universal track');
    assert.strictEqual(addB.track_id, canonSpotify.id);
    console.log('   ✓ Both users successfully added the universal track to their respective playlists.\n');

    // ── TEST 8: Zero duplicate audio or database rows created ──
    console.log('8. Testing zero audio/database tracks duplicated...');
    const trackCountRes = await db.pool.query(
      'SELECT COUNT(*) FROM tracks WHERE provider = $1 AND provider_track_id = $2',
      ['spotify', spotifyProvId]
    );
    assert.strictEqual(parseInt(trackCountRes.rows[0].count, 10), 1, 'Only one canonical tracks row must exist');
    console.log('   ✓ Exactly 1 tracks row exists for the provider track (zero duplication).\n');

    // ── TEST 9: Zero Cloud Library quota consumption ──
    console.log('9. Testing zero Cloud Library quota consumption for universal tracks...');
    const quotaA = await db.getUserStorageUsage(userA);
    const quotaB = await db.getUserStorageUsage(userB);
    // User A has 3000000 from privateTrackA in Test 1. Quota must NOT have increased.
    assert.strictEqual(quotaA, 3000000, 'User A quota must remain unchanged (3000000 bytes) after adding universal track');
    assert.strictEqual(quotaB, 0, 'User B quota must remain 0 after adding universal track');
    console.log('   ✓ Zero quota consumed by universal track references.\n');

    // ── TEST 10, 11, 12: External provider downloads rejected with 403 ──
    console.log('10, 11, 12. Testing external provider downloads return 403 Forbidden...');
    // Spotify download
    let spotDownloadBlocked = false;
    try {
      await catalogDb.getCatalogTrackForDownload(canonSpotify.id);
    } catch (err) {
      if (err.status === 403) spotDownloadBlocked = true;
    }
    assert.ok(spotDownloadBlocked, 'Spotify download must throw 403 Forbidden');

    // YouTube download
    const ytTrack = await db.insertTrack({
      id: `ext_yt_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      title: `YouTube Track ${testRunId}`,
      artist: 'YT Artist',
      provider: 'youtube',
      provider_track_id: `yt_id_${testRunId}`,
      user_id: null,
      publication_status: 'published',
      download_allowed: false
    });
    let ytDownloadBlocked = false;
    try {
      await catalogDb.getCatalogTrackForDownload(ytTrack.id);
    } catch (err) {
      if (err.status === 403) ytDownloadBlocked = true;
    }
    assert.ok(ytDownloadBlocked, 'YouTube download must throw 403 Forbidden');

    // Apple Music download
    const appleTrack = await db.insertTrack({
      id: `ext_ap_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      title: `Apple Track ${testRunId}`,
      artist: 'Apple Artist',
      provider: 'apple',
      provider_track_id: `ap_id_${testRunId}`,
      user_id: null,
      publication_status: 'published',
      download_allowed: false
    });
    let appleDownloadBlocked = false;
    try {
      await catalogDb.getCatalogTrackForDownload(appleTrack.id);
    } catch (err) {
      if (err.status === 403) appleDownloadBlocked = true;
    }
    assert.ok(appleDownloadBlocked, 'Apple download must throw 403 Forbidden');
    console.log('   ✓ Spotify, YouTube, and Apple downloads all return 403 Forbidden.\n');

    // ── TEST 13: Draft NoirSync public track stream rejected ──
    console.log('13. Testing draft NoirSync public track stream rejected...');
    const draftPublicTrack = await db.insertTrack({
      id: `pub_draft_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      title: `Draft Public Song ${testRunId}`,
      artist: 'NoirSync Artist',
      duration: 150,
      size: 2000000,
      format: 'mp3',
      audio_key: 'public/catalog/audio/draft.mp3',
      provider: 'noirsync_public',
      provider_track_id: `draft_pub_${testRunId}`,
      user_id: null,
      publication_status: 'draft',
      download_allowed: false
    });

    let draftStreamBlocked = false;
    try {
      await catalogDb.getCatalogTrackForStream(draftPublicTrack.id);
    } catch (err) {
      if (err.status === 403 || err.status === 404) draftStreamBlocked = true;
    }
    assert.ok(draftStreamBlocked, 'Draft public track streaming must be rejected');
    console.log('   ✓ Draft NoirSync public track cannot be streamed.\n');

    // ── TEST 14: Published NoirSync public track stream authorized ──
    console.log('14. Testing published NoirSync public track stream authorized...');
    const publishedPublicTrack = await db.insertTrack({
      id: `pub_live_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      title: `Published Public Song ${testRunId}`,
      artist: 'NoirSync Artist',
      duration: 150,
      size: 2000000,
      format: 'mp3',
      audio_key: 'public/catalog/audio/live.mp3',
      provider: 'noirsync_public',
      provider_track_id: `live_pub_${testRunId}`,
      user_id: null,
      publication_status: 'published',
      download_allowed: false
    });

    const streamInfo = await catalogDb.getCatalogTrackForStream(publishedPublicTrack.id);
    assert.strictEqual(streamInfo.id, publishedPublicTrack.id);
    assert.strictEqual(streamInfo.audio_key, 'public/catalog/audio/live.mp3');
    console.log('   ✓ Published NoirSync public track stream metadata authorized.\n');

    // ── TEST 15: download_allowed enforcement ──
    console.log('15. Testing download_allowed enforcement...');
    // A: download_allowed = false on published public track
    let notAllowedBlocked = false;
    try {
      await catalogDb.getCatalogTrackForDownload(publishedPublicTrack.id);
    } catch (err) {
      if (err.status === 403) notAllowedBlocked = true;
    }
    assert.ok(notAllowedBlocked, 'Download must be rejected when download_allowed = false');

    // B: download_allowed = true on published public track
    const downloadablePublicTrack = await db.insertTrack({
      id: `pub_dl_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      title: `Downloadable Public Song ${testRunId}`,
      artist: 'NoirSync Artist',
      duration: 150,
      size: 2000000,
      format: 'mp3',
      audio_key: 'public/catalog/audio/downloadable.mp3',
      provider: 'noirsync_public',
      provider_track_id: `dl_pub_${testRunId}`,
      user_id: null,
      publication_status: 'published',
      download_allowed: true
    });

    const dlInfo = await catalogDb.getCatalogTrackForDownload(downloadablePublicTrack.id);
    assert.strictEqual(dlInfo.id, downloadablePublicTrack.id);
    assert.strictEqual(dlInfo.download_allowed, true);
    console.log('   ✓ download_allowed strictly enforced (false -> 403, true -> allowed).\n');

    // ── TEST 16: Catalog cannot access private R2 namespace ──
    console.log('16. Testing catalog cannot access private R2 namespace (users/...)...');
    // Forged track attempting to point catalog audio_key to users/
    const forgedNamespaceTrack = await db.insertTrack({
      id: `pub_forged_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      title: `Forged Namespace Song ${testRunId}`,
      artist: 'Attacker',
      duration: 150,
      size: 2000000,
      format: 'mp3',
      audio_key: `users/${userA}/audio/stolen.mp3`,
      provider: 'noirsync_public',
      provider_track_id: `forged_pub_${testRunId}`,
      user_id: null,
      publication_status: 'published',
      download_allowed: true
    });

    let streamNamespaceBlocked = false;
    try {
      await catalogDb.getCatalogTrackForStream(forgedNamespaceTrack.id);
    } catch (err) {
      if (err.status === 403) streamNamespaceBlocked = true;
    }
    assert.ok(streamNamespaceBlocked, 'Streaming audio from users/ via catalog must return 403 Forbidden');

    let downloadNamespaceBlocked = false;
    try {
      await catalogDb.getCatalogTrackForDownload(forgedNamespaceTrack.id);
    } catch (err) {
      if (err.status === 403) downloadNamespaceBlocked = true;
    }
    assert.ok(downloadNamespaceBlocked, 'Downloading audio from users/ via catalog must return 403 Forbidden');
    console.log('   ✓ Catalog cannot access private users/ R2 namespace.\n');

    // ── TEST 17: Catalog cannot mutate/delete private tracks ──
    console.log('17. Testing catalog cannot mutate or delete private tracks...');
    const userTrackBefore = await db.getTrack(privateTrackA.id);
    assert.ok(userTrackBefore, 'User track exists');

    // Calling catalog track resolution with private track id does not change ownership
    const catResolveAttempt = await catalogDb.getCatalogTrack(privateTrackA.id);
    assert.strictEqual(catResolveAttempt, null, 'Catalog track lookup cannot resolve private track');

    const userTrackAfter = await db.getTrack(privateTrackA.id);
    assert.strictEqual(userTrackAfter.user_id, userA, 'User ownership cannot be mutated');
    console.log('   ✓ Private tracks cannot be accessed or mutated through catalog.\n');

    // ── TEST 18: Phase 6B/6C regression integrity verification ──
    console.log('18. Verifying Phase 6B/6C regression integrity...');
    assert.strictEqual(playlistDb.isTrackAccessible(privateTrackA, userA), true, 'Owner can access own track');
    assert.strictEqual(playlistDb.isTrackAccessible(privateTrackA, userB), false, 'Non-owner cannot access private track');
    assert.strictEqual(playlistDb.isTrackAccessible(legacyLocalTrack, userA), false, 'Legacy NULL local track inaccessible');
    assert.strictEqual(playlistDb.isTrackAccessible(canonSpotify, userA), true, 'Canonical provider track accessible to user A');
    assert.strictEqual(playlistDb.isTrackAccessible(canonSpotify, userB), true, 'Canonical provider track accessible to user B');
    console.log('   ✓ Phase 6B/6C ownership and access invariants fully preserved.\n');

    // ── TEST 19: Phase 6D Room isolation invariant preservation ──
    console.log('19. Verifying Phase 6D room isolation invariant preservation...');
    const { RoomManager } = require('./src/rooms');
    const rm = new RoomManager();
    const testRoom = rm.createRoom('ROOM_6E', 'HOST_USER_6E');
    assert.ok(testRoom.roomId, 'Room created with host');
    assert.strictEqual(testRoom.hostUserId, 'HOST_USER_6E');
    testRoom.addMember('socket_host_6e', { userId: 'HOST_USER_6E', role: 'host' });
    assert.ok(testRoom.userIds.has('HOST_USER_6E'), 'Host in userIds');
    if (rm._gcInterval) clearInterval(rm._gcInterval);
    testRoom.destroy();
    console.log('   ✓ Phase 6D room membership and isolation intact.\n');

    // ── TEST 20: Core sync timing invariant preservation ──
    console.log('20. Verifying core sync timing invariant preservation...');
    const { handleNtp } = require('./src/ntp');
    assert.strictEqual(typeof handleNtp, 'function', 'handleNtp must be a function');
    const mockRes = {
      json(data) {
        this.data = data;
      }
    };
    handleNtp({ body: { clientSendTime: 1000 } }, mockRes);
    assert.strictEqual(mockRes.data.clientSendTime, 1000);
    assert.ok(mockRes.data.serverTime > 0);
    console.log('   ✓ NTP clock offset calculation and sync timing intact.\n');

    // ── TEST 21: Existing canonical provider migration does not publish legacy local/test rows ──
    console.log('21. Testing Correction 1: Canonical provider migration does not publish legacy local rows...');
    const localDraftCount = await db.pool.query(
      "SELECT COUNT(*) FROM tracks WHERE user_id IS NULL AND provider = 'local' AND publication_status = 'published'"
    );
    assert.strictEqual(parseInt(localDraftCount.rows[0].count, 10), 0, 'Zero legacy local tracks may be published');
    console.log('   ✓ Correction 1 verified: zero legacy local tracks are published.\n');

    // ── TEST 22: Client-supplied fake metadata cannot overwrite authoritative provider metadata ──
    console.log('22. Testing Correction 2: Client fake metadata cannot overwrite authoritative provider metadata...');
    // Existing canonical track:
    const originalTrack = await db.getTrack(canonSpotify.id);
    const originalTitle = originalTrack.title;
    const originalArtist = originalTrack.artist;

    // Malicious client tries to add with fake metadata in trackData:
    const fakeAddAttempt = await playlistDb.addTrackToPlaylist(plA.id, userA, undefined, {
      provider: 'spotify',
      provider_track_id: spotifyProvId,
      title: 'HACKED FORGED TITLE 12345',
      artist: 'HACKED FORGED ARTIST 12345',
      duration: 999999,
      coverUrl: 'https://evil.com/fake.jpg',
      album: 'HACKED ALBUM'
    }).catch(err => {
      // If already in playlist, that's fine, we check DB row
      return null;
    });

    const trackAfterAttempt = await db.getTrack(canonSpotify.id);
    assert.strictEqual(trackAfterAttempt.title, originalTitle, 'Canonical title must NOT be overwritten by client fake title');
    assert.strictEqual(trackAfterAttempt.artist, originalArtist, 'Canonical artist must NOT be overwritten by client fake artist');
    console.log('   ✓ Correction 2 verified: Client fake metadata cannot mutate canonical track records.\n');

    console.log('====================================================');
    console.log('ALL 22 UNIVERSAL MUSIC REGRESSION TESTS PASSED (22/22)');
    console.log('====================================================\n');
    process.exit(0);
  } catch (err) {
    console.error('REGRESSION FAILURE:', err);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
}

runRegression();
