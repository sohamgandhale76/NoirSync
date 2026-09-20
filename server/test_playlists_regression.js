// ─── NOIRSYNC PHASE 4 REGRESSION SUITE ─────────────────────────────────────
// Tests persistent playlists, universal tracks, ordering, concurrency,
// security invariants, cascade safety, and API routes.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const assert = require('assert');
const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const db = require('./src/db');
const playlistDb = require('./src/playlists/db');
const playlistRoutes = require('./src/playlists/routes');
const { sign } = require('./src/auth/crypto');

async function runRegression() {
  console.log('=== STARTING PHASE 4 PLAYLISTS & UNIVERSAL TRACK REGRESSION ===\n');

  try {
    // ── 1. DATABASE INITIALIZATION & IDEMPOTENCY ──
    console.log('1. Testing Database Migration & Idempotency...');
    await db.initDb();
    // Run again to confirm migrations are idempotent and non-destructive
    await db.initDb();
    console.log('PASS: Database initialized and migrations are idempotent.');

    // Verify columns exist in tracks
    const colCheck = await db.pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'tracks' AND column_name IN ('album', 'external_url');
    `);
    assert.strictEqual(colCheck.rows.length, 2, 'album and external_url columns must exist on tracks');
    console.log('PASS: tracks table has album and external_url columns.');

    // ── 2. SEED TEST USERS & TRACKS ──
    const userA = `user_a_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
    const userB = `user_b_${uuidv4().replace(/-/g, '').slice(0, 8)}`;

    await db.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2), ($3, $4)', [
      userA, Date.now(), userB, Date.now()
    ]);

    const localTrack1 = await db.insertTrack({
      id: `trk_loc1_${Date.now()}`,
      title: 'Local Test Track 1',
      artist: 'Noir Artist',
      album: 'Noir Album',
      duration: 180,
      size: 5000000,
      format: 'flac',
      provider: 'local',
      provider_track_id: null,
      external_url: null,
      user_id: userA
    });

    const localTrack2 = await db.insertTrack({
      id: `trk_loc2_${Date.now()}`,
      title: 'Local Test Track 2',
      artist: 'Noir Artist',
      album: 'Noir Album',
      duration: 210,
      size: 6000000,
      format: 'mp3',
      provider: 'local',
      provider_track_id: null,
      external_url: null,
      user_id: userA
    });

    console.log('PASS: Test users and canonical tracks seeded.');

    // ── 3. PLAYLIST CRUD ──
    console.log('\n2. Testing Playlist CRUD Operations...');
    const pl1 = await playlistDb.createPlaylist(userA, 'Synthwave Vault', 'Night driving vibes');
    assert.ok(pl1.id, 'Created playlist must have an ID');
    assert.strictEqual(pl1.name, 'Synthwave Vault');
    assert.strictEqual(pl1.description, 'Night driving vibes');
    assert.strictEqual(pl1.user_id, userA);
    assert.strictEqual(pl1.track_count, 0);

    // List playlists
    const userAPlaylists = await playlistDb.getUserPlaylists(userA);
    assert.strictEqual(userAPlaylists.length, 1);
    assert.strictEqual(userAPlaylists[0].id, pl1.id);
    assert.strictEqual(userAPlaylists[0].track_count, 0);

    const userBPlaylists = await playlistDb.getUserPlaylists(userB);
    assert.strictEqual(userBPlaylists.length, 0, 'User B must have 0 playlists');

    // Get playlist by ID
    const fetched = await playlistDb.getPlaylistById(pl1.id, userA);
    assert.ok(fetched);
    assert.strictEqual(fetched.name, 'Synthwave Vault');
    assert.strictEqual(fetched.tracks.length, 0);

    // Rename & update description
    const initialUpdatedAt = pl1.updated_at;
    await new Promise(r => setTimeout(r, 20)); // Small sleep to ensure updated_at tick

    const updatedPl = await playlistDb.updatePlaylist(pl1.id, userA, {
      name: 'Cyberpunk Archives',
      description: 'Futuristic dark electro'
    });
    assert.strictEqual(updatedPl.name, 'Cyberpunk Archives');
    assert.strictEqual(updatedPl.description, 'Futuristic dark electro');
    assert.ok(updatedPl.updated_at >= initialUpdatedAt, 'updated_at must change on update');
    console.log('PASS: Playlist CRUD operations validated.');

    // ── 4. SECURITY & IDOR (User B accessing User A playlist) ──
    console.log('\n3. Testing Security Invariants & IDOR Protection...');
    
    // User B cannot GET User A playlist
    const idorGet = await playlistDb.getPlaylistById(pl1.id, userB);
    assert.strictEqual(idorGet, null, 'User B must not be able to get User A playlist');

    // User B cannot PATCH User A playlist
    const idorPatch = await playlistDb.updatePlaylist(pl1.id, userB, { name: 'Hacked Name' });
    assert.strictEqual(idorPatch, null, 'User B must not be able to update User A playlist');
    const plAfterFailedHack = await playlistDb.getPlaylistById(pl1.id, userA);
    assert.strictEqual(plAfterFailedHack.name, 'Cyberpunk Archives', 'Playlist name must remain intact');

    // User B cannot ADD track to User A playlist
    let idorAddBlocked = false;
    try {
      await playlistDb.addTrackToPlaylist(pl1.id, userB, localTrack1.id);
    } catch (err) {
      if (err.status === 404) idorAddBlocked = true;
    }
    assert.ok(idorAddBlocked, 'User B adding track to User A playlist must fail with 404');

    // User B cannot REMOVE track from User A playlist
    let idorRemoveBlocked = false;
    try {
      await playlistDb.removeTrackFromPlaylist(pl1.id, userB, localTrack1.id);
    } catch (err) {
      if (err.status === 404) idorRemoveBlocked = true;
    }
    assert.ok(idorRemoveBlocked, 'User B removing track from User A playlist must fail with 404');

    // User B cannot REORDER User A playlist
    let idorReorderBlocked = false;
    try {
      await playlistDb.reorderPlaylistTracks(pl1.id, userB, [localTrack1.id]);
    } catch (err) {
      if (err.status === 404) idorReorderBlocked = true;
    }
    assert.ok(idorReorderBlocked, 'User B reordering User A playlist must fail with 404');

    // User B cannot DELETE User A playlist
    const idorDelete = await playlistDb.deletePlaylist(pl1.id, userB);
    assert.strictEqual(idorDelete, false, 'User B must not be able to delete User A playlist');
    const plStillExists = await playlistDb.getPlaylistById(pl1.id, userA);
    assert.ok(plStillExists, 'Playlist must still exist after unauthorized delete attempt');

    // Unauthenticated access check
    let unauthBlocked = false;
    try {
      await playlistDb.createPlaylist(null, 'No Auth');
    } catch (err) {
      if (err.status === 401) unauthBlocked = true;
    }
    assert.ok(unauthBlocked, 'Null userId must be rejected with 401 Unauthorized');

    console.log('PASS: IDOR and authorization boundaries strictly enforced.');

    // ── 5. TRACKS & CANONICAL METADATA ──
    console.log('\n4. Testing Track Addition, Resolver & Canonical Metadata...');
    
    // Add local track
    const addRes1 = await playlistDb.addTrackToPlaylist(pl1.id, userA, localTrack1.id);
    assert.strictEqual(addRes1.position, 0, 'First track must have server position 0');
    assert.strictEqual(addRes1.track_id, localTrack1.id);

    // Add external/resolved track
    const externalTrackData = {
      provider: 'spotify',
      provider_track_id: `sp_${Date.now()}`,
      title: 'Midnight City',
      artist: 'M83',
      album: 'Hurry Up, We\'re Dreaming',
      duration: 243,
      cover_key: 'https://i.scdn.co/image/ab67616d0000b273',
      external_url: 'https://open.spotify.com/track/midnight'
    };

    const addRes2 = await playlistDb.addTrackToPlaylist(pl1.id, userA, null, externalTrackData);
    assert.strictEqual(addRes2.position, 1, 'Second track must have server position 1');
    assert.strictEqual(addRes2.track.title, 'Midnight City');
    assert.strictEqual(addRes2.track.album, 'Hurry Up, We\'re Dreaming');
    assert.strictEqual(addRes2.track.provider, 'spotify');
    assert.strictEqual(addRes2.track.external_url, 'https://open.spotify.com/track/midnight');

    // Duplicate rejection with 409
    let duplicateRejected = false;
    try {
      await playlistDb.addTrackToPlaylist(pl1.id, userA, localTrack1.id);
    } catch (err) {
      if (err.status === 409 && err.message.includes('already in this playlist')) {
        duplicateRejected = true;
      }
    }
    assert.ok(duplicateRejected, 'Adding duplicate track must be rejected with HTTP 409');

    // Canonical metadata authority: client cannot overwrite canonical track metadata
    const maliciousOverwriteAttempt = {
      id: localTrack1.id,
      title: 'Hacked Title Overwrite',
      artist: 'Malicious Overwriter'
    };
    // If trackId already exists in DB, ensureTrackExists must return canonical track
    const canonicalTrack = await playlistDb.ensureTrackExists(maliciousOverwriteAttempt);
    assert.strictEqual(canonicalTrack.title, 'Local Test Track 1', 'Canonical DB track metadata must not be overwritten');
    assert.strictEqual(canonicalTrack.artist, 'Noir Artist');

    console.log('PASS: Track addition, external resolution, 409 duplicates, and metadata authority verified.');

    // ── 6. ORDERING, REMOVAL COMPACTION & REORDERING ──
    console.log('\n5. Testing Ordering, Compaction, and Atomic Reordering...');

    // Add 2 more tracks
    const addRes3 = await playlistDb.addTrackToPlaylist(pl1.id, userA, localTrack2.id);
    assert.strictEqual(addRes3.position, 2, 'Third track must have position 2');

    const externalTrackData2 = {
      provider: 'youtube',
      provider_track_id: `yt_${Date.now()}`,
      title: 'Resonance',
      artist: 'HOME',
      album: 'Odyssey',
      duration: 212,
    };
    const addRes4 = await playlistDb.addTrackToPlaylist(pl1.id, userA, null, externalTrackData2);
    assert.strictEqual(addRes4.position, 3, 'Fourth track must have position 3');

    // Current tracks: [localTrack1 (pos 0), spotify (pos 1), localTrack2 (pos 2), youtube (pos 3)]
    let currentPl = await playlistDb.getPlaylistById(pl1.id, userA);
    assert.strictEqual(currentPl.tracks.length, 4);
    assert.deepStrictEqual(currentPl.tracks.map(t => t.position), [0, 1, 2, 3]);

    // Remove track at pos 1 (spotify track) -> remaining must compact to 0, 1, 2
    const spotifyTrackId = addRes2.track.id;
    await playlistDb.removeTrackFromPlaylist(pl1.id, userA, spotifyTrackId);

    currentPl = await playlistDb.getPlaylistById(pl1.id, userA);
    assert.strictEqual(currentPl.tracks.length, 3);
    assert.deepStrictEqual(currentPl.tracks.map(t => t.position), [0, 1, 2], 'Positions must be compacted to 0, 1, 2');
    assert.strictEqual(currentPl.tracks.some(t => t.id === spotifyTrackId), false);

    // Reorder tracks: reverse order
    const reversedIds = [currentPl.tracks[2].id, currentPl.tracks[1].id, currentPl.tracks[0].id];
    const reorderedPl = await playlistDb.reorderPlaylistTracks(pl1.id, userA, reversedIds);
    assert.strictEqual(reorderedPl.tracks[0].id, reversedIds[0]);
    assert.strictEqual(reorderedPl.tracks[1].id, reversedIds[1]);
    assert.strictEqual(reorderedPl.tracks[2].id, reversedIds[2]);
    assert.deepStrictEqual(reorderedPl.tracks.map(t => t.position), [0, 1, 2]);

    // Invalid reorder tests
    // 1. Duplicate IDs in reorder array
    let dupReorderRejected = false;
    try {
      await playlistDb.reorderPlaylistTracks(pl1.id, userA, [reversedIds[0], reversedIds[0], reversedIds[1]]);
    } catch (err) {
      if (err.status === 400) dupReorderRejected = true;
    }
    assert.ok(dupReorderRejected, 'Reorder with duplicate IDs must be rejected with 400');

    // 2. Count mismatch (too few IDs)
    let countMismatchRejected = false;
    try {
      await playlistDb.reorderPlaylistTracks(pl1.id, userA, [reversedIds[0]]);
    } catch (err) {
      if (err.status === 400) countMismatchRejected = true;
    }
    assert.ok(countMismatchRejected, 'Reorder with count mismatch must be rejected with 400');

    // 3. Foreign track ID
    let foreignIdRejected = false;
    try {
      await playlistDb.reorderPlaylistTracks(pl1.id, userA, [reversedIds[0], reversedIds[1], 'foreign_fake_id']);
    } catch (err) {
      if (err.status === 400) foreignIdRejected = true;
    }
    assert.ok(foreignIdRejected, 'Reorder with foreign track ID must be rejected with 400');

    console.log('PASS: Ordering, compaction, and reordering validations verified.');

    // ── 7. CONCURRENCY SAFETY (Concurrent Appends) ──
    console.log('\n6. Testing Concurrent Append Synchronization...');
    const concPlaylist = await playlistDb.createPlaylist(userA, 'Concurrency Test Playlist');

    // Seed 10 distinct tracks
    const concTrackIds = [];
    for (let i = 0; i < 10; i++) {
      const trk = await db.insertTrack({
        id: `trk_conc_${i}_${Date.now()}`,
        title: `Concurrent Song ${i}`,
        duration: 100 + i,
        provider: 'local',
        user_id: userA
      });
      concTrackIds.push(trk.id);
    }

    // Fire 10 simultaneous additions concurrently
    await Promise.all(
      concTrackIds.map((tid) => playlistDb.addTrackToPlaylist(concPlaylist.id, userA, tid))
    );

    const verifiedConcPl = await playlistDb.getPlaylistById(concPlaylist.id, userA);
    assert.strictEqual(verifiedConcPl.tracks.length, 10, 'All 10 concurrent tracks must be added');
    const positions = verifiedConcPl.tracks.map(t => t.position);
    const expectedPositions = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    assert.deepStrictEqual(positions, expectedPositions, 'Positions under concurrency must strictly be 0..9 with NO duplicates or collisions');
    console.log('PASS: Concurrent appends successfully serialized with zero position collisions.');

    // ── 8. CASCADE SAFETY & TRACK SURVIVAL ──
    console.log('\n7. Testing Cascade Safety & Underlying Track Survival...');
    // Delete playlist
    const deleteSuccess = await playlistDb.deletePlaylist(concPlaylist.id, userA);
    assert.strictEqual(deleteSuccess, true);

    // Confirm join rows in playlist_tracks are gone
    const ptRows = await db.pool.query('SELECT count(*) FROM playlist_tracks WHERE playlist_id = $1', [concPlaylist.id]);
    assert.strictEqual(parseInt(ptRows.rows[0].count), 0, 'Join rows must cascade delete with playlist');

    // Confirm underlying tracks STILL EXIST in tracks table!
    const trackCheck = await db.pool.query('SELECT count(*) FROM tracks WHERE id = ANY($1)', [concTrackIds]);
    assert.strictEqual(parseInt(trackCheck.rows[0].count), 10, 'Underlying tracks must NEVER be deleted when playlist is deleted');

    // Test deleting a track removes join row without deleting playlist
    const testTrackToDelete = concTrackIds[0];
    const dummyPl = await playlistDb.createPlaylist(userA, 'Track Delete Test');
    await playlistDb.addTrackToPlaylist(dummyPl.id, userA, testTrackToDelete);

    await db.deleteTrack(testTrackToDelete);
    const dummyPlAfterTrackDel = await playlistDb.getPlaylistById(dummyPl.id, userA);
    assert.strictEqual(dummyPlAfterTrackDel.tracks.length, 0, 'Track deletion removes reference join row');
    assert.ok(dummyPlAfterTrackDel, 'Playlist itself survives track deletion');

    console.log('PASS: Cascade safety and Invariant A verified (playlists own references, not tracks).');

    // ── 9. HTTP REST API INTEGRATION WITH SESSION COOKIES ──
    console.log('\n8. Testing HTTP API Endpoints & Express Routing...');
    const app = express();
    app.use(express.json());

    // Mock session middleware for test that inspects cookie or Authorization header
    app.use((req, res, next) => {
      const cookieHeader = req.headers.cookie;
      if (cookieHeader && cookieHeader.includes('noirsync_session=')) {
        const match = cookieHeader.match(/noirsync_session=([^;]+)/);
        if (match) {
          const { unsign } = require('./src/auth/crypto');
          req.userId = unsign(decodeURIComponent(match[1]));
        }
      }
      next();
    });

    app.use('/api/playlists', playlistRoutes);

    const testServer = http.createServer(app);
    await new Promise((resolve) => testServer.listen(0, resolve));
    const port = testServer.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const userACookie = `noirsync_session=${encodeURIComponent(sign(userA))}`;
    const userBCookie = `noirsync_session=${encodeURIComponent(sign(userB))}`;

    // Test unauthenticated access (no cookie) -> 401
    const unauthRes = await fetch(`${baseUrl}/api/playlists`);
    assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request must return 401');

    // Test User A creating playlist via POST /api/playlists
    const postRes = await fetch(`${baseUrl}/api/playlists`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: userACookie
      },
      body: JSON.stringify({ name: 'HTTP Route Playlist', description: 'Tested via HTTP' })
    });
    assert.strictEqual(postRes.status, 201);
    const postData = await postRes.json();
    assert.strictEqual(postData.playlist.name, 'HTTP Route Playlist');
    const httpPlId = postData.playlist.id;

    // Test User B trying to access User A playlist -> 404
    const idorHttpRes = await fetch(`${baseUrl}/api/playlists/${httpPlId}`, {
      headers: { Cookie: userBCookie }
    });
    assert.strictEqual(idorHttpRes.status, 404, 'User B must get 404 on User A playlist');

    // Test User A adding track via POST /api/playlists/:id/tracks
    const addTrackHttpRes = await fetch(`${baseUrl}/api/playlists/${httpPlId}/tracks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: userACookie
      },
      body: JSON.stringify({ trackId: localTrack2.id })
    });
    assert.strictEqual(addTrackHttpRes.status, 201);

    // Test duplicate track returns 409
    const dupHttpRes = await fetch(`${baseUrl}/api/playlists/${httpPlId}/tracks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: userACookie
      },
      body: JSON.stringify({ trackId: localTrack2.id })
    });
    assert.strictEqual(dupHttpRes.status, 409);
    const dupHttpData = await dupHttpRes.json();
    assert.strictEqual(dupHttpData.error, 'Track is already in this playlist');

    // Test User A deleting playlist via DELETE /api/playlists/:id
    const delHttpRes = await fetch(`${baseUrl}/api/playlists/${httpPlId}`, {
      method: 'DELETE',
      headers: { Cookie: userACookie }
    });
    assert.strictEqual(delHttpRes.status, 200);

    testServer.close();
    console.log('PASS: HTTP REST API endpoints and error statuses verified.');

    // ── 10. ROOM QUEUE CONVERSION INTEGRATION ──
    console.log('\n9. Testing Room Queue Conversion Compatibility...');
    const roomPl = await playlistDb.createPlaylist(userA, 'Room Queue Target');
    await playlistDb.addTrackToPlaylist(roomPl.id, userA, localTrack1.id);
    await playlistDb.addTrackToPlaylist(roomPl.id, userA, localTrack2.id);

    const roomPlData = await playlistDb.getPlaylistById(roomPl.id, userA);
    assert.strictEqual(roomPlData.tracks.length, 2);

    // Convert persistent playlist tracks to room queue items
    const roomQueue = roomPlData.tracks.map((pt) => ({
      id: pt.id,
      title: pt.title,
      artist: pt.artist || 'Unknown',
      duration: pt.duration,
      provider: pt.provider,
      format: pt.format,
      audio_key: pt.audio_key,
      cover_key: pt.cover_key
    }));

    assert.strictEqual(roomQueue.length, 2);
    assert.strictEqual(roomQueue[0].id, localTrack1.id);
    assert.strictEqual(roomQueue[1].id, localTrack2.id);
    console.log('PASS: Playlist cleanly translates into room queue structure.');

    // Cleanup test data
    await db.pool.query('DELETE FROM tracks WHERE id IN ($1, $2) OR user_id IN ($3, $4)', [localTrack1.id, localTrack2.id, userA, userB]);
    await db.pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userA, userB]);

    console.log('\n=== ALL PHASE 4 PLAYLIST REGRESSION CHECKS PASSED 100% ===\n');
    process.exit(0);
  } catch (err) {
    console.error('\nFAIL: Phase 4 regression error:', err);
    process.exit(1);
  }
}

runRegression();
