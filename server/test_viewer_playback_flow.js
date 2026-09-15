const http = require('http');
const io = require('socket.io-client');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function testViewerFlow() {
  console.log('=== TESTING VIEWER PLAYBACK FLOW ===\n');

  process.env.NODE_ENV = 'development';
  process.env.PORT = '3099';
  
  const libraryManager = require('./src/libraryManager');
  const tracks = libraryManager.getTracks();
  console.log(`Available tracks in library: ${tracks.length}`);
  const track = tracks[0];
  console.log(`Using track: "${track.title}" (ID: ${track.id}, filename: ${track.filename})`);

  // Start server
  require('./src/index.js');
  await new Promise(r => setTimeout(r, 1000));

  const SERVER = 'http://127.0.0.1:3099';
  const roomId = 'VIEWERTEST1';

  // 1. Connect Host
  console.log('\n1. Connecting Host...');
  const hostSocket = io(SERVER, { transports: ['websocket'] });
  await new Promise(res => hostSocket.on('connect', res));
  
  const hostJoinedPromise = new Promise(res => hostSocket.on('room:joined', res));
  hostSocket.emit('room:join', { roomId, role: 'host', displayName: 'HostDJ' });
  await hostJoinedPromise;
  console.log('PASS: Host joined room');

  // 2. Host loads library track and plays
  console.log('\n2. Host loading library track...');
  const trackLoadedPromise = new Promise(res => hostSocket.on('sync:track_loaded', res));
  hostSocket.emit('host:load_library_track', { roomId, trackId: track.id });
  const trackLoadedState = await trackLoadedPromise;
  console.log(`PASS: Track loaded on server. libraryTrackId = ${trackLoadedState.libraryTrackId}, songName = "${trackLoadedState.songName}"`);

  console.log('\n3. Host starting playback...');
  const hostPlayPromise = new Promise(res => hostSocket.on('sync:play', res));
  hostSocket.emit('host:play', { roomId, currentTime: 0, chunkIndex: 0 });
  const playData = await hostPlayPromise;
  console.log(`PASS: Play scheduled. scheduledStartTime = ${playData.scheduledStartTime}, currentTime = ${playData.currentTime}`);

  // Wait 2 seconds to simulate playback in progress
  console.log('Waiting 2 seconds (playback in progress)...');
  await new Promise(r => setTimeout(r, 2000));

  // 4. Guest connects and joins room
  console.log('\n4. Guest connecting and joining room...');
  const viewerSocket = io(SERVER, { transports: ['websocket'] });
  await new Promise(res => viewerSocket.on('connect', res));

  const viewerJoinedPromise = new Promise(res => viewerSocket.on('room:joined', res));
  viewerSocket.emit('room:join', { roomId, role: 'viewer', displayName: 'GuestListener' });
  const viewerJoinedData = await viewerJoinedPromise;

  console.log('\n--- VIEWER INITIAL ROOM STATE ---');
  console.log(JSON.stringify(viewerJoinedData.state, null, 2));

  assert.strictEqual(viewerJoinedData.state.libraryTrackId, track.id, 'libraryTrackId must match loaded track');
  assert.strictEqual(viewerJoinedData.state.isPlaying, true, 'isPlaying must be true');
  assert.notStrictEqual(viewerJoinedData.state.scheduledStartTime, null, 'scheduledStartTime must not be null');

  // 5. Test audio download endpoint for this track ID
  console.log('\n5. Testing /api/library/tracks/:id/download as requested by Viewer...');
  const downloadUrl = `/api/library/tracks/${track.id}/download`;
  
  const getPromise = (options) => new Promise((resolve, reject) => {
    http.get(options, (res) => {
      let data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        bodyLength: Buffer.concat(data).length
      }));
    }).on('error', reject);
  });

  const res200 = await getPromise({ hostname: '127.0.0.1', port: 3099, path: downloadUrl });
  console.log(`HTTP GET ${downloadUrl} -> Status: ${res200.statusCode}, Content-Type: ${res200.headers['content-type']}, Length: ${res200.bodyLength}`);
  assert.strictEqual(res200.statusCode, 200);

  // 6. Test Range request
  console.log('\n6. Testing Range request (bytes=0-1023)...');
  const res206 = await getPromise({
    hostname: '127.0.0.1',
    port: 3099,
    path: downloadUrl,
    headers: { Range: 'bytes=0-1023' }
  });
  console.log(`HTTP Range GET ${downloadUrl} -> Status: ${res206.statusCode}, Content-Range: ${res206.headers['content-range']}, Length: ${res206.bodyLength}`);
  assert.strictEqual(res206.statusCode, 206);

  console.log('\n=== SERVER-SIDE VIEWER DATA IS 100% VALID ===');

  hostSocket.disconnect();
  viewerSocket.disconnect();
  process.exit(0);
}

testViewerFlow().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
