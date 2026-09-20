// ─── Playlist & Track Integrity Regression Suite ─────────────────────────────
// Tests:
// 1. Canonical provider recognition (spotify, youtube, apple)
// 2. Shared Cloud/R2 track addition: User A creates, User B & User C can add to their playlists
// 3. User B retrieves playlist containing User A's Cloud track; track is present and R2 keys sanitized
// 4. No duplicate track row created when multiple users add same Cloud track
// 5. Private non-cloud track (audio_key IS NULL, user_id = userA): User A can add, User B cannot (HTTP 404)
// 6. Shared Cloud track with user_id = NULL (audio_key IS NOT NULL) can be added to playlists by any user
// 7. Invalid local track (user_id = NULL, audio_key = NULL) cannot be added (HTTP 404)
// 7. Canonical provider tracks (spotify, youtube, apple with user_id = NULL) can be added by multiple users
// 8. Historical invalid reference cleanup (cleanupInvalidPlaylistTracks detaches non-cloud cross-user references, preserves shared Cloud tracks)
// 9. Playlist response sanitization: raw R2 keys (audio_key, cover_key, lyrics_key) never exposed
// 10. Track deletion cascade: deleting shared track cascades to all referencing playlists
// 11. Playlist deletion preserves underlying tracks

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const db = require('./src/db');
const playlistDb = require('./src/playlists/db');
const { isCanonicalProvider } = require('./src/music/registry');

async function runRegression() {
  console.log('=== PLAYLIST & TRACK INTEGRITY REGRESSION TESTS ===\n');

  try {
    // 0. Initialize database and ensure tables and schema_migrations exist
    await db.initDb();

    const testRunId = Date.now();
    const userA = `u_6c_a_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
    const userB = `u_6c_b_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
    const userC = `u_6c_c_${uuidv4().replace(/-/g, '').slice(0, 8)}`;

    await db.pool.query('INSERT INTO users (id, created_at, is_guest) VALUES ($1, $2, false), ($3, $4, false), ($5, $6, false)', [
      userA, testRunId, userB, testRunId, userC, testRunId
    ]);

    console.log('1. Testing canonical provider recognition...');
    assert.strictEqual(isCanonicalProvider('spotify'), true, 'spotify must be recognized');
    assert.strictEqual(isCanonicalProvider('Spotify'), true, 'spotify (case-insensitive) must be recognized');
    assert.strictEqual(isCanonicalProvider('youtube'), true, 'youtube must be recognized');
    assert.strictEqual(isCanonicalProvider('apple'), true, 'apple must be recognized');
    assert.strictEqual(isCanonicalProvider('local'), false, 'local must NOT be recognized as canonical external provider');
    assert.strictEqual(isCanonicalProvider(''), false, 'empty provider must not be recognized');
    assert.strictEqual(isCanonicalProvider(null), false, 'null provider must not be recognized');
    console.log('   ✓ Canonical providers recognized correctly (spotify, youtube, apple only).\n');

    // ── TEST 1: Shared Cloud/R2 track addition across users ──
    console.log('2. Testing shared Cloud/R2 track addition across users...');
    const cloudTrackA = await db.insertTrack({
      id: `trk_cloud_${testRunId}`,
      title: 'Shared Cloud Anthem',
      artist: 'Artist A',
      duration: 200,
      size: 4000000,
      format: 'mp3',
      audio_key: `users/${userA}/audio/anthem.mp3`,
      cover_key: `users/${userA}/covers/anthem.jpg`,
      lyrics_key: `users/${userA}/lyrics/anthem.lrc`,
      provider: 'local',
      user_id: userA
    });

    const plA = await playlistDb.createPlaylist(userA, 'User A Playlist');
    const plB = await playlistDb.createPlaylist(userB, 'User B Playlist');
    const plC = await playlistDb.createPlaylist(userC, 'User C Playlist');

    // User A adds own Cloud track to User A playlist
    const addOwn = await playlistDb.addTrackToPlaylist(plA.id, userA, cloudTrackA.id);
    assert.ok(addOwn, 'User A should successfully add own Cloud track');
    assert.strictEqual(addOwn.track_id, cloudTrackA.id);
    console.log('   ✓ User A can add own Cloud track to own playlist.');

    // User B adds User A's Cloud track to User B playlist
    const addB = await playlistDb.addTrackToPlaylist(plB.id, userB, cloudTrackA.id);
    assert.ok(addB, 'User B should successfully add User A shared Cloud track');
    assert.strictEqual(addB.track_id, cloudTrackA.id);
    console.log('   ✓ User B can add User A shared Cloud track to User B playlist.');

    // User C adds User A's Cloud track to User C playlist
    const addC = await playlistDb.addTrackToPlaylist(plC.id, userC, cloudTrackA.id);
    assert.ok(addC, 'User C should successfully add User A shared Cloud track');
    assert.strictEqual(addC.track_id, cloudTrackA.id);
    console.log('   ✓ User C can add same shared Cloud track to User C playlist.');

    // Verify no duplicate track row was created
    const trackRowCount = await db.pool.query('SELECT COUNT(*) FROM tracks WHERE id = $1', [cloudTrackA.id]);
    assert.strictEqual(parseInt(trackRowCount.rows[0].count, 10), 1, 'Exactly 1 canonical row must exist for the shared track');
    console.log('   ✓ No duplicate track row created in database.');

    // Verify User B can retrieve their playlist and the track is present and sanitized
    const plBData = await playlistDb.getPlaylistById(plB.id, userB);
    assert.ok(plBData, 'User B playlist retrieved');
    const foundInB = plBData.tracks.find(t => t.id === cloudTrackA.id);
    assert.ok(foundInB, 'Shared Cloud track must be present in User B playlist');
    assert.strictEqual(foundInB.audio_key, undefined, 'audio_key must be sanitized');
    assert.strictEqual(foundInB.cover_key, undefined, 'cover_key must be sanitized');
    assert.strictEqual(foundInB.lyrics_key, undefined, 'lyrics_key must be sanitized');
    assert.strictEqual(foundInB.track_user_id, undefined, 'track_user_id must be sanitized');
    assert.strictEqual(foundInB.has_cover, true);
    assert.strictEqual(foundInB.cover_url, `/library/${cloudTrackA.id}/cover`);
    console.log('   ✓ User B retrieves playlist with shared Cloud track present and sanitized.\n');

    // ── TEST 2: Private non-cloud track (audio_key IS NULL, user_id = userA) ──
    console.log('3. Testing private non-cloud track (audio_key IS NULL)...');
    const privateNoAudio = await db.insertTrack({
      id: `trk_priv_no_audio_${testRunId}`,
      title: 'Private Draft Without Audio',
      artist: 'Artist A',
      duration: 100,
      audio_key: null,
      provider: 'local',
      user_id: userA
    });

    // User A can add own private non-cloud track
    const addPrivOwn = await playlistDb.addTrackToPlaylist(plA.id, userA, privateNoAudio.id);
    assert.ok(addPrivOwn, 'User A can add own private non-cloud track');

    // User B CANNOT add User A's private non-cloud track (HTTP 404)
    let userBAddBlocked = false;
    try {
      await playlistDb.addTrackToPlaylist(plB.id, userB, privateNoAudio.id);
    } catch (err) {
      if (err.status === 404) {
        userBAddBlocked = true;
      }
    }
    assert.ok(userBAddBlocked, 'User B adding User A private non-cloud track must be rejected with HTTP 404');
    console.log('   ✓ User B cannot add User A private non-cloud track to User B playlist (HTTP 404).\n');

    // ── TEST 3: Shared Cloud track with user_id = NULL can be added by any user ──
    console.log('4. Testing shared Cloud track with user_id = NULL can be added to playlists...');
    const historicalCloudTrack = await db.insertTrack({
      id: `trk_hist_cloud_${testRunId}`,
      title: 'Historical Shared Cloud Track With Audio Key',
      artist: 'Historical Artist',
      duration: 150,
      audio_key: 'legacy/shared/audio.mp3',
      provider: 'local',
      user_id: null
    });

    const addHistA = await playlistDb.addTrackToPlaylist(plA.id, userA, historicalCloudTrack.id);
    assert.ok(addHistA, 'User A should be able to add historical shared Cloud track with user_id=NULL');
    assert.strictEqual(addHistA.track_id, historicalCloudTrack.id);

    const addHistB = await playlistDb.addTrackToPlaylist(plB.id, userB, historicalCloudTrack.id);
    assert.ok(addHistB, 'User B should be able to add historical shared Cloud track with user_id=NULL');
    assert.strictEqual(addHistB.track_id, historicalCloudTrack.id);
    console.log('   ✓ Shared Cloud track with user_id=NULL can be added to playlists by multiple users.');

    // Local track with audio_key = NULL and user_id = NULL cannot be added (HTTP 404)
    const invalidLocalTrack = await db.insertTrack({
      id: `trk_invalid_no_audio_${testRunId}`,
      title: 'Invalid Local Track Without Audio or User',
      artist: 'Unknown',
      duration: 100,
      audio_key: null,
      provider: 'local',
      user_id: null
    });

    let invalidAddBlocked = false;
    try {
      await playlistDb.addTrackToPlaylist(plA.id, userA, invalidLocalTrack.id);
    } catch (err) {
      if (err.status === 404) {
        invalidAddBlocked = true;
      }
    }
    assert.ok(invalidAddBlocked, 'Local track with user_id=NULL and audio_key=NULL must NOT be addable to playlists');
    console.log('   ✓ Local track without audio_key and user_id=NULL cannot be added (HTTP 404).\n');

    // ── TEST 4: Canonical provider tracks (user_id = NULL) shared across users ──
    console.log('5. Testing canonical provider tracks (spotify, youtube, apple)...');
    const spotifyTrack = await db.insertTrack({
      id: `trk_spot_${testRunId}`,
      title: 'Spotify Hit Song',
      artist: 'Star Artist',
      duration: 180,
      provider: 'spotify',
      provider_track_id: `spot_${testRunId}`,
      cover_key: 'https://i.scdn.co/image/ab67616d0000b273test',
      user_id: null
    });

    const addSpotA = await playlistDb.addTrackToPlaylist(plA.id, userA, spotifyTrack.id);
    assert.ok(addSpotA, 'User A can add canonical Spotify track');
    const addSpotB = await playlistDb.addTrackToPlaylist(plB.id, userB, spotifyTrack.id);
    assert.ok(addSpotB, 'User B can add the same canonical Spotify track');
    console.log('   ✓ Canonical Spotify track with user_id=NULL can be added by multiple users.\n');

    // ── TEST 5: Cleanup of invalid cross-user references ──
    console.log('6. Testing audit & cleanup of historical cross-user playlist_tracks references...');
    // Artificially inject an invalid cross-user reference into playlist_tracks (for private track without audio_key)
    const invalidPtId = `pt_invalid_${testRunId}`;
    await db.pool.query(`
      INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_at)
      VALUES ($1, $2, $3, 999, $4)
    `, [invalidPtId, plB.id, privateNoAudio.id, Date.now()]);

    // Verify the invalid reference exists in DB
    const beforeCheck = await db.pool.query(
      'SELECT pt.id FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id JOIN tracks t ON t.id = pt.track_id WHERE p.user_id != t.user_id AND t.user_id IS NOT NULL AND t.audio_key IS NULL AND pt.id = $1',
      [invalidPtId]
    );
    assert.strictEqual(beforeCheck.rows.length, 1, 'Invalid cross-user reference must be present before cleanup');

    // Run cleanup with force: true
    const cleanupResult = await playlistDb.cleanupInvalidPlaylistTracks(db.pool, { force: true });
    assert.ok(cleanupResult.executed, 'Cleanup must execute');
    assert.ok(cleanupResult.deletedCount >= 1, `Cleanup must detach at least 1 invalid reference (detached: ${cleanupResult.deletedCount})`);

    // Verify invalid reference was removed
    const afterCheck = await db.pool.query('SELECT 1 FROM playlist_tracks WHERE id = $1', [invalidPtId]);
    assert.strictEqual(afterCheck.rows.length, 0, 'Invalid cross-user reference must be deleted from playlist_tracks');

    // Verify valid shared Cloud track references in plB and plC were PRESERVED!
    const plBTracksAfterCleanup = await db.pool.query('SELECT track_id FROM playlist_tracks WHERE playlist_id = $1', [plB.id]);
    assert.ok(plBTracksAfterCleanup.rows.some(r => r.track_id === cloudTrackA.id), 'Shared Cloud track in User B playlist must be preserved');

    // Verify underlying tracks and playlists were NOT deleted
    const trackCheck = await db.pool.query('SELECT id, user_id FROM tracks WHERE id = $1', [cloudTrackA.id]);
    assert.strictEqual(trackCheck.rows.length, 1, 'Underlying track must NOT be deleted');
    assert.strictEqual(trackCheck.rows[0].user_id, userA, 'Underlying track ownership must NOT be reassigned');
    console.log('   ✓ Invalid cross-user reference detached; shared Cloud tracks and playlists preserved.\n');

    // ── TEST 6: Playlist privacy (User B cannot access User A playlist) ──
    console.log('7. Testing playlist privacy...');
    const accessOtherPl = await playlistDb.getPlaylistById(plA.id, userB);
    assert.strictEqual(accessOtherPl, null, 'User B must NOT be able to access User A playlist');
    console.log('   ✓ Private playlist ownership strictly preserved.\n');

    // ── TEST 7: Track deletion cascade across users ──
    console.log('8. Testing track deletion cascade safety across users...');
    const trackToDelete = await db.insertTrack({
      id: `trk_del_${testRunId}`,
      title: 'Shared Track To Delete',
      artist: 'Artist A',
      duration: 100,
      audio_key: `users/${userA}/audio/del.mp3`,
      provider: 'local',
      user_id: userA
    });

    await playlistDb.addTrackToPlaylist(plA.id, userA, trackToDelete.id);
    await playlistDb.addTrackToPlaylist(plB.id, userB, trackToDelete.id);

    // User B (non-uploader) CANNOT delete User A's track
    const delAttemptB = await db.deleteTrack(trackToDelete.id, userB);
    assert.strictEqual(delAttemptB, null, 'Non-uploader must NOT be able to delete track');

    // User A (uploader) deletes own track
    const delResultA = await db.deleteTrack(trackToDelete.id, userA);
    assert.ok(delResultA, 'Uploader must be able to delete track');

    // Check cascade: track removed from BOTH User A and User B playlists
    const plAAfterDel = await playlistDb.getPlaylistById(plA.id, userA);
    assert.strictEqual(plAAfterDel.tracks.some(t => t.id === trackToDelete.id), false, 'Deleted track removed from User A playlist');
    const plBAfterDel = await playlistDb.getPlaylistById(plB.id, userB);
    assert.strictEqual(plBAfterDel.tracks.some(t => t.id === trackToDelete.id), false, 'Deleted track removed from User B playlist');

    // Both playlists still survive
    assert.ok(plAAfterDel, 'Playlist A survives track deletion');
    assert.ok(plBAfterDel, 'Playlist B survives track deletion');
    console.log('   ✓ Track deletion cascades across playlists; non-uploader cannot delete track.\n');

    // ── TEST 8: Playlist deletion preserves underlying tracks ──
    console.log('9. Testing playlist deletion preserves underlying tracks...');
    await playlistDb.deletePlaylist(plA.id, userA);
    const trackAAfterPlDelete = await db.getTrack(cloudTrackA.id);
    assert.ok(trackAAfterPlDelete, 'Underlying track must survive playlist deletion');
    console.log('   ✓ Playlist deletion preserves underlying tracks.\n');

    // Cleanup test data
    await db.pool.query('DELETE FROM playlists WHERE id IN ($1, $2, $3)', [plA.id, plB.id, plC.id]);
    await db.pool.query('DELETE FROM tracks WHERE id IN ($1, $2, $3, $4, $5, $6)', [
      cloudTrackA.id, privateNoAudio.id, historicalCloudTrack.id, invalidLocalTrack.id, spotifyTrack.id, trackToDelete.id
    ]);
    await db.pool.query('DELETE FROM users WHERE id IN ($1, $2, $3)', [userA, userB, userC]);

    console.log('=== ALL PLAYLIST & TRACK INTEGRITY REGRESSION TESTS PASSED 100% ===\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ REGRESSION TEST FAILED:', err);
    process.exit(1);
  }
}

runRegression();
