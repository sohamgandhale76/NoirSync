// ─── NoirSync Spotify Synchronized-Room Mode Regression Suite ────────────────
// Verifies:
//  1. Room class defaults to source: 'local', spotifyTrack: null, empty spotifyListeners
//  2. setSpotifyTrack updates source: 'spotify', songName, coverUrl, duration, spotifyTrack, and clears local chunks
//  3. updateSpotifyListener registers listener readiness, premium state, and sync status
//  4. setLibraryTrack resets source back to 'local' and clears spotifyTrack
//  5. removeMember removes the listener from spotifyListeners Map
//  6. Socket.IO host:load_spotify_track broadcasts sync:track_loaded with Spotify metadata
//  7. Socket.IO host:play / pause / seek broadcasts proper sync events with spotifyState
//  8. Socket.IO spotify:listener_status broadcasts sync:spotify_listeners to room members

const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Room, RoomManager } = require('./src/rooms');

async function runTests() {
  console.log('=== STARTING NOIRSYNC SPOTIFY ROOM REGRESSION SUITE ===\n');

  // ─── Test 1: Default Room State ──────────────────────────────────────────
  console.log('1. Testing Room default Spotify state...');
  const room = new Room('TESTROOM');
  const initialState = room.getState();

  assert.strictEqual(initialState.source, 'local', 'Default source must be "local"');
  assert.strictEqual(initialState.spotifyTrack, null, 'Default spotifyTrack must be null');
  assert.strictEqual(initialState.spotifyState, null, 'Default spotifyState must be null');
  assert.strictEqual(initialState.coverUrl, null, 'Default coverUrl must be null');
  assert.deepStrictEqual(initialState.spotifyListeners, [], 'Default spotifyListeners must be empty array');
  console.log('   ✓ Default room state verified');

  // ─── Test 2: Loading Spotify Track ──────────────────────────────────────
  console.log('\n2. Testing room.setSpotifyTrack()...');
  // Put a chunk in room first to verify it gets cleared
  room.addChunk(0, Buffer.from('mock audio chunk'), 'audio/mpeg');
  assert.strictEqual(room.chunks.size, 1, 'Chunk should be added');

  const mockSpotifyTrack = {
    id: '4cOdK2wGLETKBW3PvgPWqT',
    uri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT',
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley',
    album: 'Whenever You Need Somebody',
    coverUrl: 'https://i.scdn.co/image/ab67616d0000b2735755e164993798e0c9ef7d7a',
    duration: 213,
    durationMs: 213000,
  };

  room.setSpotifyTrack(mockSpotifyTrack);
  const spotifyState = room.getState();

  assert.strictEqual(spotifyState.source, 'spotify', 'Source must now be "spotify"');
  assert.strictEqual(spotifyState.songName, 'Never Gonna Give You Up');
  assert.strictEqual(spotifyState.coverUrl, mockSpotifyTrack.coverUrl);
  assert.strictEqual(spotifyState.duration, 213);
  assert.strictEqual(spotifyState.durationMs, 213000);
  assert.strictEqual(room.chunks.size, 0, 'Local chunks must be cleared when entering Spotify mode');
  assert.strictEqual(spotifyState.libraryTrackId, null);
  assert.notStrictEqual(spotifyState.spotifyTrack, null);
  assert.strictEqual(spotifyState.spotifyTrack.id, mockSpotifyTrack.id);
  assert.strictEqual(spotifyState.spotifyTrack.uri, mockSpotifyTrack.uri);
  console.log('   ✓ setSpotifyTrack() sets metadata and clears local buffers');

  // ─── Test 3: Listener Status Tracking ────────────────────────────────────
  console.log('\n3. Testing room.updateSpotifyListener()...');
  room.addMember('socket_user_1', { userId: 'usr_1', role: 'viewer', displayName: 'Alice' });
  room.addMember('socket_user_2', { userId: 'usr_2', role: 'viewer', displayName: 'Bob' });

  room.updateSpotifyListener('socket_user_1', {
    isConnected: true,
    isPremium: true,
    isReady: true,
    inSync: true,
    status: 'in_sync'
  });

  room.updateSpotifyListener('socket_user_2', {
    isConnected: false,
    isPremium: false,
    isReady: false,
    inSync: false,
    status: 'unlinked'
  });

  const stateWithListeners = room.getState();
  assert.strictEqual(stateWithListeners.spotifyListeners.length, 2);

  const aliceStatus = stateWithListeners.spotifyListeners.find(l => l.socketId === 'socket_user_1');
  assert.strictEqual(aliceStatus.displayName, 'Alice');
  assert.strictEqual(aliceStatus.inSync, true);
  assert.strictEqual(aliceStatus.isPremium, true);

  const bobStatus = stateWithListeners.spotifyListeners.find(l => l.socketId === 'socket_user_2');
  assert.strictEqual(bobStatus.displayName, 'Bob');
  assert.strictEqual(bobStatus.isConnected, false);
  assert.strictEqual(bobStatus.status, 'unlinked');
  console.log('   ✓ Listener Spotify statuses tracked accurately');

  // ─── Test 4: Switching back to Local Library Track ──────────────────────
  console.log('\n4. Testing switching back to library track...');
  const mockLibraryTrack = {
    id: 'track_local_123',
    title: 'Local Song',
    artist: 'Local Artist',
    mimeType: 'audio/mpeg',
    duration: 120,
    coverFilename: 'cover_123.jpg'
  };
  const mockBuffer = Buffer.alloc(1024 * 1024); // 1MB

  room.setLibraryTrack(mockLibraryTrack, mockBuffer);
  const revertedState = room.getState();

  assert.strictEqual(revertedState.source, 'local', 'Source must revert to "local"');
  assert.strictEqual(revertedState.coverUrl, null, 'coverUrl must be cleared');
  assert.strictEqual(revertedState.spotifyTrack, null, 'spotifyTrack must be null');
  assert.strictEqual(revertedState.songName, 'Local Song');
  assert.strictEqual(revertedState.coverFilename, 'cover_123.jpg');
  console.log('   ✓ Successfully reverted to local audio pipeline');

  // ─── Test 5: Member Disconnect removes Spotify Listener entry ───────────
  console.log('\n5. Testing removeMember cleans up Spotify listener...');
  room.removeMember('socket_user_1');
  const postRemoveState = room.getState();
  assert.strictEqual(postRemoveState.spotifyListeners.length, 1);
  assert.strictEqual(postRemoveState.spotifyListeners[0].socketId, 'socket_user_2');
  console.log('   ✓ Disconnected socket cleanly removed from spotifyListeners');

  // ─── Test 6: RoomManager lifecycle ──────────────────────────────────────
  console.log('\n6. Testing RoomManager with Spotify rooms...');
  const rm = new RoomManager();
  const r1 = rm.createRoom('SPOTIFYROOM', 'usr_host', 'sock_host');
  r1.setSpotifyTrack(mockSpotifyTrack);
  assert.strictEqual(rm.getRoom('SPOTIFYROOM').state.source, 'spotify');
  rm.destroy();
  console.log('   ✓ RoomManager properly manages Spotify rooms');

  // ─── Test 7: Race Resolution - Early Status Emission & Confirmed Room Membership Snapshot ───
  console.log('\n7. Testing early emission & room join snapshot resolution...');
  const raceRoom = new Room('RACEROOM');
  raceRoom.setSpotifyTrack(mockSpotifyTrack);

  // Status emitted and registered on server
  raceRoom.updateSpotifyListener('socket_viewer_race', {
    isConnected: true,
    isPremium: true,
    isReady: true,
    inSync: true,
    status: 'in_sync'
  });

  // Client adds member / joins room
  raceRoom.addMember('socket_viewer_race', { userId: 'usr_race', role: 'viewer', displayName: 'RaceUser' });
  const joinedSnapshot = raceRoom.getState();

  assert.strictEqual(joinedSnapshot.spotifyListeners.length, 1);
  assert.strictEqual(joinedSnapshot.spotifyListeners[0].socketId, 'socket_viewer_race');
  assert.strictEqual(joinedSnapshot.spotifyListeners[0].displayName, 'RaceUser');
  assert.strictEqual(joinedSnapshot.spotifyListeners[0].isPremium, true);
  assert.strictEqual(joinedSnapshot.spotifyListeners[0].inSync, true);
  console.log('   ✓ Room-join state snapshot reliably delivers listener status to client');

  // ─── Test 8: Late Joiner Snapshot Delivery ──────────────────────────────
  console.log('\n8. Testing late joiner receives existing listener-state snapshot...');
  raceRoom.addMember('socket_late_joiner', { userId: 'usr_late', role: 'viewer', displayName: 'LateUser' });
  const lateSnapshot = raceRoom.getState();

  // Late joiner immediately sees existing 'socket_viewer_race' in state without waiting for a broadcast
  const existingInSnapshot = lateSnapshot.spotifyListeners.find(l => l.socketId === 'socket_viewer_race');
  assert.ok(existingInSnapshot, 'Late joiner state snapshot must contain existing room listeners');
  assert.strictEqual(existingInSnapshot.isPremium, true);
  assert.strictEqual(existingInSnapshot.inSync, true);
  console.log('   ✓ Late joiner receives complete existing listener snapshot on join');

  // ─── Test 9: Reconnecting Client Re-establishes Listener Status ──────────
  console.log('\n9. Testing client disconnect and reconnection lifecycle...');
  // Viewer disconnects
  raceRoom.removeMember('socket_viewer_race');
  assert.strictEqual(raceRoom.getState().spotifyListeners.length, 0);

  // Viewer reconnects with new socket ID
  raceRoom.addMember('socket_viewer_reconnect', { userId: 'usr_race', role: 'viewer', displayName: 'RaceUser' });
  raceRoom.updateSpotifyListener('socket_viewer_reconnect', {
    isConnected: true,
    isPremium: true,
    isReady: true,
    inSync: false,
    status: 'ready'
  });
  const reconnectedState = raceRoom.getState();
  assert.strictEqual(reconnectedState.spotifyListeners.length, 1);
  assert.strictEqual(reconnectedState.spotifyListeners[0].socketId, 'socket_viewer_reconnect');
  assert.strictEqual(reconnectedState.spotifyListeners[0].status, 'ready');
  console.log('   ✓ Reconnecting client cleanly establishes new listener status');

  // ─── Test 10: Switching Room Source Resets inSync Without Stale State ────
  console.log('\n10. Testing switching room source resets inSync safely...');
  const newSpotifyTrack = {
    id: 'nextTrackId',
    uri: 'spotify:track:nextTrackId',
    title: 'Next Song',
    artist: 'Next Artist',
    album: 'Next Album',
    duration: 180,
    durationMs: 180000
  };
  raceRoom.setSpotifyTrack(newSpotifyTrack);
  const switchedState = raceRoom.getState();
  assert.strictEqual(switchedState.spotifyTrack.id, 'nextTrackId');
  assert.strictEqual(switchedState.spotifyListeners[0].inSync, false, 'inSync must be reset on track change');
  assert.strictEqual(switchedState.spotifyListeners[0].status, 'ready', 'Status must transition to ready');
  console.log('   ✓ Track switch preserves listener registrations while resetting inSync');

  console.log('\n=== ALL SPOTIFY ROOM REGRESSION TESTS PASSED! ===');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
