const io = require('socket.io-client');
const assert = require('assert');

function connectSocket(name) {
  return new Promise((resolve, reject) => {
    const socket = io('http://127.0.0.1:3001', {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });
    socket.on('connect', () => {
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      reject(err);
    });
  });
}

async function runRegression() {
  console.log('=== STARTING NOIRSYNC PROTOCOL & MULTI-CLIENT REGRESSION ===\n');

  const net = require('net');
  const isRunning = await new Promise((resolve) => {
    const tester = net.createConnection({ port: 3001, host: '127.0.0.1' }, () => {
      tester.end();
      resolve(true);
    }).on('error', () => resolve(false));
  });

  if (!isRunning) {
    console.log('Server not running on 3001, starting embedded server...');
    process.env.PORT = '3001';
    require('./src/index.js');
    await new Promise(r => setTimeout(r, 1000));
  }

  const roomId = 'TESTROOM' + Math.floor(1000 + Math.random() * 9000);
  console.log(`Using Room ID: ${roomId}`);

  // 1. Host Connects & Creates/Joins Room
  console.log('1. Host connecting...');
  const host = await connectSocket('Host');
  console.log(`Host connected (socket id: ${host.id})`);

  const hostJoinPromise = new Promise((resolve) => {
    host.on('room:joined', (data) => resolve(data));
  });
  host.emit('room:join', { roomId, role: 'host', displayName: 'DJ Host' });
  const hostJoinData = await hostJoinPromise;
  assert.strictEqual(hostJoinData.role, 'host');
  assert.strictEqual(hostJoinData.roomId, roomId);
  console.log('PASS: Host joined room successfully.');

  // 2. Viewer 1 Connects & Joins Room
  console.log('\n2. Viewer 1 connecting & joining room...');
  const viewer1 = await connectSocket('Viewer 1');
  const viewer1JoinPromise = new Promise((resolve) => {
    viewer1.on('room:joined', (data) => resolve(data));
  });
  const hostMemberJoinedPromise = new Promise((resolve) => {
    host.on('room:member_joined', (data) => resolve(data));
  });

  viewer1.emit('room:join', { roomId, role: 'viewer', displayName: 'Listener 1' });
  const viewer1JoinData = await viewer1JoinPromise;
  const hostNotif = await hostMemberJoinedPromise;

  assert.strictEqual(viewer1JoinData.role, 'viewer');
  assert.strictEqual(hostNotif.displayName, 'Listener 1');
  assert.strictEqual(hostNotif.memberCount, 2);
  console.log('PASS: Viewer 1 joined and Host received member_joined notification.');

  // 3. NTP Clock Synchronization
  console.log('\n3. Testing NTP Clock Sync...');
  const ntpPromise = new Promise((resolve) => {
    const t0 = Date.now();
    viewer1.on('ntp:pong', ({ clientSendTime, serverTime }) => {
      const t3 = Date.now();
      const rtt = t3 - clientSendTime;
      const offset = serverTime - (clientSendTime + rtt / 2);
      console.log(`NTP Pong: RTT = ${rtt}ms, Clock Offset = ${offset.toFixed(2)}ms`);
      assert(rtt >= 0);
      assert(serverTime > 0);
      resolve({ rtt, offset });
    });
    viewer1.emit('ntp:ping', { clientSendTime: t0 });
  });
  await ntpPromise;
  console.log('PASS: NTP synchronization handshake successful.');

  // 4. Host Loads Track from Library
  console.log('\n4. Host loading library track (01. The Weeknd - Alone Again)...');
  const trackId = '568bb911-c885-4325-b436-f2d3d0d00aa6';
  const trackLoadedPromise = new Promise((resolve) => {
    viewer1.on('sync:track_loaded', (state) => {
      console.log(`Viewer 1 received track_loaded: "${state.songName}" (chunks: ${state.totalChunks})`);
      resolve(state);
    });
  });
  host.emit('host:load_library_track', { roomId, trackId });
  const loadedState = await trackLoadedPromise;
  assert(loadedState.songName.includes('Alone Again') || loadedState.songName.length > 0);
  console.log('PASS: Track loaded and broadcasted to Viewer 1.');

  // 5. Host Updates Queue
  console.log('\n5. Host updating queue...');
  const queueUpdatePromise = new Promise((resolve) => {
    viewer1.on('sync:track_loaded', (state) => {
      if (state.queue && state.queue.length > 0) {
        resolve(state);
      }
    });
  });
  const mockQueue = [
    { id: trackId, title: 'Alone Again', artist: 'The Weeknd' },
    { id: 'a519be00-c81f-4341-b6ae-c2bc9ba06b7d', title: 'Best Friends', artist: 'The Weeknd' }
  ];
  host.emit('host:update_queue', { roomId, queue: mockQueue, currentQueueIndex: 0 });
  const queueState = await queueUpdatePromise;
  assert.strictEqual(queueState.queue.length, 2);
  assert.strictEqual(queueState.currentQueueIndex, 0);
  console.log('PASS: Queue update synchronized to Viewer 1.');

  // 6. Playback Play Synchronization
  console.log('\n6. Host starts playback (sync:play)...');
  const playPromise = new Promise((resolve) => {
    viewer1.on('sync:play', (data) => {
      console.log(`Viewer 1 received sync:play -> scheduledStartTime: ${data.scheduledStartTime}, currentTime: ${data.currentTime}`);
      assert(data.scheduledStartTime > Date.now(), 'Start time should be scheduled in the future for buffer alignment');
      assert.strictEqual(data.currentTime, 0);
      resolve(data);
    });
  });
  host.emit('host:play', { roomId, currentTime: 0, chunkIndex: 0 });
  await playPromise;
  console.log('PASS: Play event scheduled and synchronized to Viewer 1.');

  // 7. Playback Pause Synchronization
  console.log('\n7. Host pauses playback (sync:pause)...');
  const pausePromise = new Promise((resolve) => {
    viewer1.on('sync:pause', (data) => {
      console.log(`Viewer 1 received sync:pause -> currentTime: ${data.currentTime}`);
      assert.strictEqual(data.currentTime, 15.2);
      resolve(data);
    });
  });
  host.emit('host:pause', { roomId, currentTime: 15.2 });
  await pausePromise;
  console.log('PASS: Pause event synchronized to Viewer 1.');

  // 8. Playback Seek Synchronization
  console.log('\n8. Host seeks playback (sync:seek)...');
  const seekPromise = new Promise((resolve) => {
    viewer1.on('sync:seek', (data) => {
      console.log(`Viewer 1 received sync:seek -> currentTime: ${data.currentTime}`);
      assert.strictEqual(data.currentTime, 45.0);
      resolve(data);
    });
  });
  host.emit('host:seek', { roomId, currentTime: 45.0, chunkIndex: 2 });
  await seekPromise;
  console.log('PASS: Seek event synchronized to Viewer 1.');

  // 9. Join-in-Progress (Viewer 2 catches up)
  console.log('\n9. Viewer 2 joins room in-progress...');
  const viewer2 = await connectSocket('Viewer 2');
  const viewer2JoinPromise = new Promise((resolve) => {
    viewer2.on('room:joined', (data) => resolve(data));
  });
  viewer2.emit('room:join', { roomId, role: 'viewer', displayName: 'Late Comer' });
  const viewer2JoinData = await viewer2JoinPromise;

  assert.strictEqual(viewer2JoinData.state.currentTime, 45.0, 'Late joiner must receive current seek position');
  assert.strictEqual(viewer2JoinData.state.isPlaying, false, 'Late joiner must receive current pause status');
  assert.strictEqual(viewer2JoinData.state.queue.length, 2, 'Late joiner must receive current queue');
  console.log('PASS: Viewer 2 accurately caught up with existing room state (time: 45.0s, queue: 2 tracks).');

  // 10. Viewer Disconnect
  console.log('\n10. Viewer 2 disconnects...');
  const memberLeftPromise = new Promise((resolve) => {
    host.on('room:member_left', (data) => {
      console.log(`Host received room:member_left: socket ${data.socketId}, remaining members: ${data.memberCount}`);
      resolve(data);
    });
  });
  viewer2.disconnect();
  const leftData = await memberLeftPromise;
  assert.strictEqual(leftData.memberCount, 2);
  console.log('PASS: Disconnect event properly decremented room members.');

  // Clean up remaining
  host.disconnect();
  viewer1.disconnect();

  console.log('\n=== ALL REAL-TIME REGRESSION TESTS PASSED 100% ===');
  process.exit(0);
}

runRegression().catch(err => {
  console.error('Regression Failed:', err);
  process.exit(1);
});
