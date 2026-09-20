const io = require('socket.io-client');
const http = require('http');
const assert = require('assert');

function connectSocket() {
  return new Promise((resolve, reject) => {
    const socket = io('http://127.0.0.1:3001', {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

async function testTiming() {
  console.log('=== MEASURING TIMING & SYNC DELAY ===\n');

  // Check if server is running on 3001
  const net = require('net');
  const isRunning = await new Promise((resolve) => {
    const tester = net.createConnection({ port: 3001, host: '127.0.0.1' }, () => {
      tester.end();
      resolve(true);
    }).on('error', () => resolve(false));
  });

  // Helper: wait for actual server readiness (TCP listening + /health responding)
  function waitForServerReady(port = 3001, host = '127.0.0.1', timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const interval = 50;

      const check = () => {
        const socket = net.createConnection({ port, host }, () => {
          socket.end();
          http.get(`http://${host}:${port}/health`, (res) => {
            if (res.statusCode === 200) {
              resolve();
            } else {
              retry();
            }
          }).on('error', retry);
        });

        socket.on('error', retry);
      };

      const retry = () => {
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Server failed to become ready on ${host}:${port} within ${timeoutMs}ms`));
        } else {
          setTimeout(check, interval);
        }
      };

      check();
    });
  }

  if (!isRunning) {
    console.log('Starting server on port 3001...');
    process.env.PORT = '3001';
    require('./src/index.js');
    await waitForServerReady(3001);
    console.log('Server is ready and accepting requests.');
  }

  const SERVER = 'http://127.0.0.1:3001';
  const roomId = 'TIMINGTEST' + Math.floor(1000 + Math.random() * 9000);

  // NTP Sync measurement
  async function getNtpOffset() {
    const t0 = Date.now();
    const res = await fetch(`${SERVER}/api/ntp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientSendTime: t0 }),
    });
    const t3 = Date.now();
    const data = await res.json();
    const t1 = data.serverTime;
    const rtt = t3 - t0;
    const offset = t1 - (t0 + rtt / 2);
    return { offset, rtt };
  }

  const hostNtp = await getNtpOffset();
  const viewerNtp = await getNtpOffset();
  console.log(`NTP Clock Offset (Host): ${hostNtp.offset.toFixed(2)}ms (RTT: ${hostNtp.rtt}ms)`);
  console.log(`NTP Clock Offset (Viewer): ${viewerNtp.offset.toFixed(2)}ms (RTT: ${viewerNtp.rtt}ms)`);

  // Connect Host
  const hostSocket = await connectSocket();
  const hostJoinPromise = new Promise(r => hostSocket.on('room:joined', r));
  hostSocket.emit('room:join', { roomId, role: 'host', displayName: 'Host' });
  await hostJoinPromise;

  // Connect Viewer
  const viewerSocket = await connectSocket();
  const viewerJoinPromise = new Promise(r => viewerSocket.on('room:joined', r));
  viewerSocket.emit('room:join', { roomId, role: 'viewer', displayName: 'Viewer' });
  await viewerJoinPromise;

  const libraryManager = require('./src/libraryManager');
  const track = libraryManager.getTracks()[0];

  // Host loads track
  const trackLoadedPromise = new Promise(r => viewerSocket.on('sync:track_loaded', r));
  hostSocket.emit('host:load_library_track', { roomId, trackId: track.id });
  await trackLoadedPromise;

  console.log('\nMeasuring Synchronized Host Play -> Viewer Play pipeline:');
  const t_host_click = Date.now();
  console.log(`1. Host button click timestamp: ${t_host_click}`);

  let t_host_receive = 0;
  let t_host_play_actual = 0;

  const hostPlayPromise = new Promise((resolve) => {
    hostSocket.on('sync:play', async (data) => {
      t_host_receive = Date.now();
      const scheduledStartTime = data.scheduledStartTime;
      const msUntil = scheduledStartTime - t_host_receive;
      setTimeout(() => {
        t_host_play_actual = Date.now();
        resolve({ t_host_play_actual, scheduledStartTime });
      }, Math.max(0, msUntil));
    });
  });

  let t_viewer_receive = 0;
  let t_viewer_play_actual = 0;

  const viewerPlayPromise = new Promise((resolve) => {
    viewerSocket.on('sync:play', async (data) => {
      t_viewer_receive = Date.now();
      const scheduledStartTime = data.scheduledStartTime;
      const deliveryLatency = t_viewer_receive - t_host_click;
      console.log(`4. Viewer receive timestamp: ${t_viewer_receive}`);
      console.log(`   Socket delivery latency: ${deliveryLatency}ms`);
      console.log(`   Scheduled start time T: ${scheduledStartTime} (${scheduledStartTime - t_viewer_receive}ms in future)`);

      // Mock audio loading/preparation
      const t_prep_start = Date.now();
      await new Promise(res => setTimeout(res, 25)); // simulate ~25ms metadata load/seek
      const t_prep_end = Date.now();
      const prepTime = t_prep_end - t_prep_start;
      console.log(`5. Audio preparation time: ${prepTime}ms`);

      const now = Date.now();
      const msUntil = scheduledStartTime - now;
      console.log(`   Viewer waiting until scheduled start: ${msUntil}ms`);

      setTimeout(() => {
        t_viewer_play_actual = Date.now();
        resolve({ t_viewer_play_actual, deliveryLatency, prepTime });
      }, Math.max(0, msUntil));
    });
  });

  // Host emits play
  hostSocket.emit('host:play', { roomId, currentTime: 0, chunkIndex: 0 });

  await Promise.all([hostPlayPromise, viewerPlayPromise]);

  console.log(`\n8. Actual Host play timestamp:   ${t_host_play_actual}`);
  console.log(`9. Actual Viewer play timestamp: ${t_viewer_play_actual}`);
  const offset = Math.abs(t_viewer_play_actual - t_host_play_actual);
  console.log(`\nABSOLUTE OFFSET: ${offset}ms`);

  hostSocket.disconnect();
  viewerSocket.disconnect();

  process.exit(0);
}

testTiming().catch(err => {
  console.error(err);
  process.exit(1);
});
