// ─── Phase 6C Playlist & Track Integrity Regression Suite ─────────────────────
// Tests:
// 1. Local track with user_id = NULL cannot be newly added to a playlist (HTTP 404)
// 2. Cross-user private track addition is rejected (User B cannot add User A's private track) (HTTP 404)
// 3. User A can add own private Cloud Library track to own playlist (HTTP 201)
// 4. Canonical provider tracks (spotify, youtube, apple with user_id = NULL) can be added by multiple users
// 5. Existing cross-user playlist_tracks references (playlist.user_id != track.user_id AND track.user_id IS NOT NULL) are detected and detached
// 6. Cleanup never deletes underlying tracks
// 7. Cleanup never deletes playlists
// 8. Cleanup never reassigns ownership
// 9. Cleanup preserves valid owner references and canonical provider tracks
// 10. Cleanup is idempotent (recorded in schema_migrations)
// 11. Playlist response (getPlaylistById) completely omits another user's private track
// 12. Playlist response returns requester-owned private tracks and canonical provider tracks
// 13. Playlist response never exposes raw R2 storage keys (audio_key, cover_key, lyrics_key)
// 14. Playlist response provides safe authenticated cover URL (/library/:id/cover for private tracks, CDN URL for provider tracks)
// 15. Track deletion cascades safely only to owner's playlists and does not affect other users or playlists
// 16. Playlist deletion removes join rows without deleting underlying tracks

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const db = require('./src/db');
const playlistDb = require('./src/playlists/db');
const { isCanonicalProvider } = require('./src/music/registry');

async function runRegression() {
  console.log('=== PHASE 6C — PLAYLIST & TRACK INTEGRITY REGRESSION TESTS ===\n');

  try {
    // 0. Initialize database and ensure tables and schema_migrations exist
    await db.initDb();

    const testRunId = Date.now();
    const userA = `u_6c_a_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
    const userB = `u_6c_b_${uuidv4().replace(/-/g, '').slice(0, 8)}`;

    await db.pool.query('INSERT INTO users (id, created_at, is_guest) VALUES ($1, $2, false), ($3, $4, false)', [
      userA, testRunId, userB, testRunId
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

    // ── TEST 1: User A private track vs User B ──
    console.log('2. Testing private track addition & ownership boundary...');
    const trackA = await db.insertTrack({
      id: `trk_a_${testRunId}`,
      title: 'User A Private Song',
      artist: 'Artist A',
      duration: 200,
      size: 4000000,
      format: 'mp3',
      audio_key: `users/${userA}/audio/songA.mp3`,
      cover_key: `users/${userA}/covers/songA.jpg`,
      lyrics_key: `users/${userA}/lyrics/songA.lrc`,
      provider: 'local',
      user_id: userA
    });

    const plA = await playlistDb.createPlaylist(userA, 'User A Playlist');
    const plB = await playlistDb.createPlaylist(userB, 'User B Playlist');

    // User A can add own track to own playlist
    const addOwn = await playlistDb.addTrackToPlaylist(plA.id, userA, trackA.id);
    assert.ok(addOwn, 'User A should successfully add own track');
    assert.strictEqual(addOwn.track_id, trackA.id);
    console.log('   ✓ User A can add own private track to own playlist.');

    // User B CANNOT add User A's private track to User B's playlist (HTTP 404)
    let userBAddBlocked = false;
    try {
      await playlistDb.addTrackToPlaylist(plB.id, userB, trackA.id);
    } catch (err) {
      if (err.status === 404) {
        userBAddBlocked = true;
      }
    }
    assert.ok(userBAddBlocked, 'User B adding User A private track must be rejected with HTTP 404');
    console.log('   ✓ User B cannot add User A private track to User B playlist (HTTP 404).\n');

    // ── TEST 2: Orphaned local track (user_id = NULL) cannot be newly added ──
    console.log('3. Testing orphaned/legacy local track (user_id = NULL)...');
    const orphanedLocalTrack = await db.insertTrack({
      id: `trk_orph_${testRunId}`,
      title: 'Legacy Orphaned Local Track',
      artist: 'Unknown Artist',
      duration: 150,
      provider: 'local',
      user_id: null
    });

    let orphanedAddBlocked = false;
    try {
      await playlistDb.addTrackToPlaylist(plA.id, userA, orphanedLocalTrack.id);
    } catch (err) {
      if (err.status === 404) {
        orphanedAddBlocked = true;
      }
    }
    assert.ok(orphanedAddBlocked, 'Orphaned local track with user_id=NULL must NOT be addable to playlists');
    console.log('   ✓ Local track with user_id=NULL cannot be newly added (HTTP 404).\n');

    // ── TEST 3: Canonical provider tracks (user_id = NULL) shared across users ──
    console.log('4. Testing canonical provider tracks (spotify, youtube, apple)...');
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

    // ── TEST 4: Existing cross-user playlist reference detection & detachment ──
    console.log('5. Testing audit & cleanup of historical cross-user playlist_tracks references...');
    // Artificially inject an invalid cross-user reference into playlist_tracks (simulating pre-Phase 6C data)
    const invalidPtId = `pt_invalid_${testRunId}`;
    await db.pool.query(`
      INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_at)
      VALUES ($1, $2, $3, 999, $4)
    `, [invalidPtId, plB.id, trackA.id, Date.now()]);

    // Verify the invalid reference exists in the DB
    const beforeCheck = await db.pool.query(
      'SELECT pt.id FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id JOIN tracks t ON t.id = pt.track_id WHERE p.user_id != t.user_id AND t.user_id IS NOT NULL AND pt.id = $1',
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

    // Verify trackA was NOT deleted!
    const trackCheck = await db.pool.query('SELECT id, user_id FROM tracks WHERE id = $1', [trackA.id]);
    assert.strictEqual(trackCheck.rows.length, 1, 'Underlying track must NOT be deleted');
    assert.strictEqual(trackCheck.rows[0].user_id, userA, 'Underlying track ownership must NOT be reassigned');

    // Verify playlists were NOT deleted!
    const plACheck = await db.pool.query('SELECT id FROM playlists WHERE id = $1', [plA.id]);
    const plBCheck = await db.pool.query('SELECT id FROM playlists WHERE id = $1', [plB.id]);
    assert.strictEqual(plACheck.rows.length, 1, 'Playlist A must NOT be deleted');
    assert.strictEqual(plBCheck.rows.length, 1, 'Playlist B must NOT be deleted');

    // Verify valid references were preserved
    const plATracks = await db.pool.query('SELECT track_id FROM playlist_tracks WHERE playlist_id = $1', [plA.id]);
    assert.ok(plATracks.rows.some(r => r.track_id === trackA.id), 'Valid owner track in Playlist A must be preserved');
    assert.ok(plATracks.rows.some(r => r.track_id === spotifyTrack.id), 'Valid canonical Spotify track in Playlist A must be preserved');

    // Verify idempotence: second run without force should return executed: false
    const secondRun = await playlistDb.cleanupInvalidPlaylistTracks(db.pool, { force: false });
    assert.strictEqual(secondRun.executed, false, 'Second run without force must be a no-op (idempotent)');
    assert.strictEqual(secondRun.deletedCount, 0);
    console.log('   ✓ Invalid cross-user reference detected and detached.');
    console.log('   ✓ Underlying tracks and playlists preserved, ownership unchanged.');
    console.log('   ✓ Cleanup is idempotent and recorded in schema_migrations.\n');

    // ── TEST 5: Playlist response (getPlaylistById) completely omits unauthorized tracks ──
    console.log('6. Testing playlist response omission of unauthorized tracks & R2 key stripping...');
    // Again inject an invalid track into plB to test getPlaylistById defense-in-depth omission
    const tempPtId = `pt_temp_${testRunId}`;
    await db.pool.query(`
      INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_at)
      VALUES ($1, $2, $3, 888, $4)
    `, [tempPtId, plB.id, trackA.id, Date.now()]);

    const plBData = await playlistDb.getPlaylistById(plB.id, userB);
    assert.ok(plBData);
    // plB should only contain spotifyTrack, NOT trackA!
    const containsTrackA = plBData.tracks.some(t => t.id === trackA.id);
    assert.strictEqual(containsTrackA, false, 'Playlist response must OMIT another user\'s private track entirely');
    assert.strictEqual(plBData.track_count, plBData.tracks.length, 'track_count must reflect only accessible tracks');
    console.log('   ✓ Playlist response completely omits another user\'s private track.');

    // Check R2 key sanitization for User A's playlist response
    const plAData = await playlistDb.getPlaylistById(plA.id, userA);
    assert.ok(plAData);
    for (const t of plAData.tracks) {
      assert.strictEqual(t.audio_key, undefined, 'Raw audio_key must NEVER be exposed in playlist response');
      assert.strictEqual(t.cover_key, undefined, 'Raw cover_key must NEVER be exposed in playlist response');
      assert.strictEqual(t.lyrics_key, undefined, 'Raw lyrics_key must NEVER be exposed in playlist response');
      assert.strictEqual(t.track_user_id, undefined, 'Internal track_user_id must not be exposed');

      if (t.id === trackA.id) {
        assert.strictEqual(t.has_cover, true, 'has_cover must be true for track with cover');
        assert.strictEqual(t.cover_url, `/library/${trackA.id}/cover`, 'cover_url must point to authenticated library endpoint');
      } else if (t.id === spotifyTrack.id) {
        assert.strictEqual(t.has_cover, true, 'has_cover must be true for Spotify track');
        assert.strictEqual(t.cover_url, 'https://i.scdn.co/image/ab67616d0000b273test', 'cover_url must be external CDN for Spotify track');
      }
    }
    console.log('   ✓ Raw R2 keys (audio_key, cover_key, lyrics_key) are never exposed in playlist responses.');
    console.log('   ✓ Safe authenticated cover_url (/library/:id/cover) provided for private tracks.\n');

    // Clean up temporary injected row
    await db.pool.query('DELETE FROM playlist_tracks WHERE id = $1', [tempPtId]);

    // ── TEST 6: Cascade safety on track deletion ──
    console.log('7. Testing track deletion cascade safety across users...');
    const trackToDelete = await db.insertTrack({
      id: `trk_del_${testRunId}`,
      title: 'Track To Delete',
      artist: 'Artist A',
      duration: 100,
      provider: 'local',
      user_id: userA
    });

    await playlistDb.addTrackToPlaylist(plA.id, userA, trackToDelete.id);
    const plABeforeDelete = await playlistDb.getPlaylistById(plA.id, userA);
    assert.ok(plABeforeDelete.tracks.some(t => t.id === trackToDelete.id));

    // User A deletes own track
    await db.deleteTrack(trackToDelete.id, userA);

    const plAAfterDelete = await playlistDb.getPlaylistById(plA.id, userA);
    assert.strictEqual(plAAfterDelete.tracks.some(t => t.id === trackToDelete.id), false, 'Deleted track removed from User A playlist');

    // Playlist A still exists and is healthy
    assert.ok(plAAfterDelete, 'Playlist A survives track deletion');

    // User B playlist completely unaffected
    const plBAfterDelete = await playlistDb.getPlaylistById(plB.id, userB);
    assert.ok(plBAfterDelete, 'Playlist B completely unaffected');
    console.log('   ✓ Track deletion cascades safely within owner boundary without affecting other users or playlists.\n');

    // ── TEST 7: Playlist deletion preserves underlying tracks ──
    console.log('8. Testing playlist deletion preserves underlying tracks...');
    await playlistDb.deletePlaylist(plA.id, userA);
    const trackAAfterPlDelete = await db.getTrack(trackA.id);
    assert.ok(trackAAfterPlDelete, 'Underlying track must survive playlist deletion');
    console.log('   ✓ Playlist deletion preserves underlying tracks.\n');

    // Cleanup test data
    await db.pool.query('DELETE FROM playlists WHERE id IN ($1, $2)', [plA.id, plB.id]);
    await db.pool.query('DELETE FROM tracks WHERE id IN ($1, $2, $3, $4)', [
      trackA.id, orphanedLocalTrack.id, spotifyTrack.id, trackToDelete.id
    ]);
    await db.pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userA, userB]);

    console.log('=== ALL PHASE 6C PLAYLIST & TRACK INTEGRITY REGRESSION TESTS PASSED 100% ===\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ REGRESSION TEST FAILED:', err);
    process.exit(1);
  }
}

runRegression();
