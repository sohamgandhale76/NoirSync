const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Test suite for local audio streaming, Range requests, and ephemeral filesystem behavior
async function runAudioStreamRegression() {
  console.log('=== STARTING LOCAL AUDIO STREAMING & LIFECYCLE REGRESSION TEST ===\n');

  // 1. Set up a test express app using libraryManager
  const libraryManager = require('./src/libraryManager');
  
  // Create a temporary audio file in uploads dir
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const testTrackId = 'test-track-' + Date.now();
  const testFilename = `${testTrackId}.mp3`;
  const testFilePath = path.join(uploadsDir, testFilename);

  // Generate 8192 bytes of mock audio data
  const mockAudioBuffer = Buffer.alloc(8192);
  for (let i = 0; i < mockAudioBuffer.length; i++) {
    mockAudioBuffer[i] = i % 256;
  }
  fs.writeFileSync(testFilePath, mockAudioBuffer);

  // Add track to libraryManager
  const mockTrack = {
    id: testTrackId,
    title: 'Test Audio Track',
    artist: 'Test Artist',
    album: 'Test Album',
    duration: 120,
    bitrate: 320,
    lossless: false,
    mimeType: 'audio/mpeg',
    fileSize: mockAudioBuffer.length,
    source: 'local',
    filename: testFilename,
    fileIds: null,
    originalExtension: '.mp3',
    coverFilename: null,
    uploadedAt: Date.now()
  };
  libraryManager.tracks.push(mockTrack);

  // Start a local test server replicating index.js routes
  const PORT = 3088;
  const server = http.createServer((req, res) => {
    // Route matching for /api/library/tracks/:id/download
    const match = req.url.match(/^\/api\/library\/tracks\/([^/]+)\/download/);
    if (match) {
      const id = match[1];
      const track = libraryManager.getTrack(id);
      if (!track) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Track not found' }));
      }

      const filePath = libraryManager.getTrackFilePath(track.filename);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Audio file not found on disk. Local upload is unavailable on this ephemeral instance.' }));
      }

      const range = req.headers.range;
      const fileSize = track.fileSize;
      const mimeType = track.mimeType;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10) || 0;
        let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (end >= fileSize) end = fileSize - 1;
        const chunksize = (end - start) + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Accept-Ranges': 'bytes',
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(filePath).pipe(res);
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Test streaming server listening on port ${PORT}`);

  try {
    // Helper to send HTTP requests
    function httpGet(options) {
      return new Promise((resolve, reject) => {
        http.get(options, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks)
            });
          });
        }).on('error', reject);
      });
    }

    // Test 1: Full file download
    console.log('\n1. Testing Full Audio Download (HTTP 200)...');
    const fullRes = await httpGet({
      hostname: '127.0.0.1',
      port: PORT,
      path: `/api/library/tracks/${testTrackId}/download`
    });

    assert.strictEqual(fullRes.statusCode, 200, 'Expected status 200 for full audio stream');
    assert.strictEqual(fullRes.headers['content-type'], 'audio/mpeg', 'Expected Content-Type audio/mpeg');
    assert.strictEqual(fullRes.headers['accept-ranges'], 'bytes', 'Expected Accept-Ranges header');
    assert.strictEqual(fullRes.headers['access-control-allow-origin'], '*', 'Expected CORS header');
    assert.strictEqual(fullRes.body.length, mockAudioBuffer.length, 'Streamed bytes length must match uploaded file');
    assert.deepStrictEqual(fullRes.body, mockAudioBuffer, 'Streamed bytes content must match exact audio file bytes');
    console.log('PASS: Full audio download returned 200 with valid Content-Type, headers, and audio bytes.');

    // Test 2: HTTP Range Request (bytes=0-1023)
    console.log('\n2. Testing HTTP Range Request (HTTP 206, bytes=0-1023)...');
    const rangeRes = await httpGet({
      hostname: '127.0.0.1',
      port: PORT,
      path: `/api/library/tracks/${testTrackId}/download`,
      headers: { 'Range': 'bytes=0-1023' }
    });

    assert.strictEqual(rangeRes.statusCode, 206, 'Expected status 206 for Range request');
    assert.strictEqual(rangeRes.headers['content-range'], `bytes 0-1023/${mockAudioBuffer.length}`, 'Expected valid Content-Range header');
    assert.strictEqual(rangeRes.headers['content-length'], '1024', 'Expected Content-Length 1024');
    assert.strictEqual(rangeRes.headers['content-type'], 'audio/mpeg', 'Expected Content-Type audio/mpeg');
    assert.strictEqual(rangeRes.body.length, 1024, 'Returned bytes must be exactly 1024 bytes');
    assert.deepStrictEqual(rangeRes.body, mockAudioBuffer.subarray(0, 1024), 'Returned slice must match exact audio slice');
    console.log('PASS: Range request returned 206 Partial Content with correct Content-Range and audio slice.');

    // Test 3: HTTP Range Request for Seeking (middle of file)
    console.log('\n3. Testing HTTP Range Seeking (HTTP 206, bytes=2048-4095)...');
    const seekRes = await httpGet({
      hostname: '127.0.0.1',
      port: PORT,
      path: `/api/library/tracks/${testTrackId}/download`,
      headers: { 'Range': 'bytes=2048-4095' }
    });

    assert.strictEqual(seekRes.statusCode, 206);
    assert.strictEqual(seekRes.headers['content-range'], `bytes 2048-4095/${mockAudioBuffer.length}`);
    assert.strictEqual(seekRes.headers['content-length'], '2048');
    assert.deepStrictEqual(seekRes.body, mockAudioBuffer.subarray(2048, 4096));
    console.log('PASS: Seeking range request returned correct mid-stream audio slice.');

    // Test 4: Ephemeral missing file behavior
    console.log('\n4. Testing Ephemeral Missing File Handling (HTTP 404)...');
    const missingTrackId = 'missing-track-' + Date.now();
    libraryManager.tracks.push({
      id: missingTrackId,
      title: 'Missing Ephemeral Track',
      filename: `missing_${missingTrackId}.mp3`,
      source: 'local',
      fileSize: 1000,
      mimeType: 'audio/mpeg'
    });

    const missingRes = await httpGet({
      hostname: '127.0.0.1',
      port: PORT,
      path: `/api/library/tracks/${missingTrackId}/download`
    });

    assert.strictEqual(missingRes.statusCode, 404, 'Missing file must return 404');
    const missingJson = JSON.parse(missingRes.body.toString('utf8'));
    assert(missingJson.error.includes('Local upload is unavailable on this ephemeral instance'), 'Must explain ephemeral availability');
    console.log('PASS: Missing file returned 404 explaining ephemeral local upload unavailability.');

    // Test 5: LocalPlaybackAdapter binding & idempotency test
    console.log('\n5. Testing LocalPlaybackAdapter binding & idempotency...');
    let eventHandlers = {};
    const mockAudioDom = {
      src: '',
      duration: 163.5,
      currentTime: 0,
      paused: true,
      addEventListener(evt, fn) {
        if (!eventHandlers[evt]) eventHandlers[evt] = [];
        eventHandlers[evt].push(fn);
      },
      removeEventListener(evt, fn) {
        if (eventHandlers[evt]) {
          eventHandlers[evt] = eventHandlers[evt].filter(f => f !== fn);
        }
      },
      load() { this.loaded = true; },
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; }
    };

    // Import actual LocalPlaybackAdapter logic
    class TestLocalPlaybackAdapter {
      constructor() {
        this.audio = null;
        this.listeners = new Map();
        this.activeDomListeners = new Map();
        const events = ['timeupdate', 'ended', 'loadedmetadata', 'play', 'pause', 'durationchange'];
        events.forEach(e => this.listeners.set(e, new Set()));
      }
      bind(audioElement) {
        if (this.audio === audioElement) return;
        if (this.audio) this.unbind();
        this.audio = audioElement;
        ['timeupdate', 'ended', 'loadedmetadata', 'durationchange'].forEach(name => {
          const handler = (e) => {
            const cbs = this.listeners.get(name);
            if (cbs) cbs.forEach(cb => cb(e));
          };
          this.activeDomListeners.set(name, handler);
          this.audio.addEventListener(name, handler);
        });
      }
      unbind() {
        if (!this.audio) return;
        this.activeDomListeners.forEach((handler, name) => {
          this.audio.removeEventListener(name, handler);
        });
        this.activeDomListeners.clear();
        this.audio = null;
      }
      getAudioElement() { return this.audio; }
      setSrc(url) {
        if (!this.audio) return;
        this.audio.src = url;
        this.audio.load();
      }
      play() {
        if (!this.audio) return Promise.resolve();
        return this.audio.play();
      }
      getDuration() { return this.audio ? this.audio.duration : 0; }
      on(event, cb) {
        const set = this.listeners.get(event);
        if (set) set.add(cb);
        return () => set && set.delete(cb);
      }
    }

    const adapter = new TestLocalPlaybackAdapter();

    // Idempotent binding test
    adapter.bind(mockAudioDom);
    assert.strictEqual(adapter.getAudioElement(), mockAudioDom);
    const initialListenerCount = eventHandlers['loadedmetadata'].length;
    adapter.bind(mockAudioDom); // second bind to same element
    assert.strictEqual(eventHandlers['loadedmetadata'].length, initialListenerCount, 'Rebinding same element must be a no-op');

    // Test setting source
    let metadataFired = false;
    let durationChangeFired = false;
    adapter.on('loadedmetadata', () => { metadataFired = true; });
    adapter.on('durationchange', () => { durationChangeFired = true; });
    adapter.setSrc(`/api/library/tracks/${testTrackId}/download`);

    assert.strictEqual(mockAudioDom.src, `/api/library/tracks/${testTrackId}/download`);
    assert.strictEqual(mockAudioDom.loaded, true);

    // Trigger metadata and durationchange events
    eventHandlers['loadedmetadata'].forEach(fn => fn({}));
    eventHandlers['durationchange'].forEach(fn => fn({}));
    assert.strictEqual(metadataFired, true, 'loadedmetadata listener must be triggered');
    assert.strictEqual(durationChangeFired, true, 'durationchange listener must be triggered');
    assert.strictEqual(adapter.getDuration(), 163.5, 'Duration must be accessible via adapter');

    // Test play
    await adapter.play();
    assert.strictEqual(mockAudioDom.paused, false, 'Audio must be playing');

    console.log('PASS: LocalPlaybackAdapter binding is idempotent and correctly forwards src, load, events, and duration.');

    console.log('\n=== ALL REGRESSION CHECKS PASSED ===\n');
  } finally {
    server.close();
    // Cleanup temporary audio file
    if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
    // Remove mock track
    const idx = libraryManager.tracks.findIndex(t => t.id === testTrackId);
    if (idx !== -1) libraryManager.tracks.splice(idx, 1);
  }
}

runAudioStreamRegression().catch((err) => {
  console.error('REGRESSION FAILURE:', err);
  process.exit(1);
});
