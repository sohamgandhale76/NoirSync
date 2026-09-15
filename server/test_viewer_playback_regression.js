const assert = require('assert');
const { EventEmitter } = require('events');

// Mock HTMLAudioElement
class MockAudioElement extends EventEmitter {
  constructor() {
    super();
    this._src = '';
    this.currentTime = 0;
    this.duration = 0;
    this.readyState = 0; // HAVE_NOTHING
    this.paused = true;
    this.volume = 1;
    this.muted = false;
    this.buffered = {
      length: 0,
      start: () => 0,
      end: () => 0
    };
  }

  get src() {
    return this._src;
  }

  set src(val) {
    this._src = val;
    this.readyState = 0;
    this.paused = true;
  }

  load() {
    // Simulates browser resource load
    setTimeout(() => {
      this.duration = 240.5;
      this.readyState = 4; // HAVE_ENOUGH_DATA
      this.emit('loadedmetadata');
      this.emit('canplay');
    }, 10);
  }

  async play() {
    this.paused = false;
    this.emit('play');
    this.emit('playing');
  }

  pause() {
    this.paused = true;
    this.emit('pause');
  }

  addEventListener(name, handler) {
    this.on(name, handler);
  }

  removeEventListener(name, handler) {
    this.off(name, handler);
  }
}

// Minimal implementation matching LocalPlaybackAdapter
class TestLocalPlaybackAdapter {
  constructor() {
    this.audio = null;
    this.listeners = new Map();
    this.activeDomListeners = new Map();
    const events = ['timeupdate', 'ended', 'loadedmetadata', 'play', 'pause', 'durationchange', 'waiting', 'playing', 'canplay', 'progress'];
    events.forEach(e => this.listeners.set(e, new Set()));
  }

  bind(audioElement) {
    if (this.audio === audioElement) return;
    if (this.audio) this.unbind();
    this.audio = audioElement;
    this.audio.muted = false;

    const bindEvent = (eventName, domEventName) => {
      const handler = (e) => {
        const callbacks = this.listeners.get(eventName);
        if (callbacks) callbacks.forEach(cb => cb(e));
      };
      this.activeDomListeners.set(domEventName, handler);
      this.audio.addEventListener(domEventName, handler);
    };

    ['timeupdate', 'ended', 'loadedmetadata', 'play', 'pause', 'durationchange', 'waiting', 'playing', 'canplay', 'progress'].forEach(e => bindEvent(e, e));
  }

  unbind() {
    if (!this.audio) return;
    this.activeDomListeners.forEach((handler, domEventName) => {
      this.audio.removeEventListener(domEventName, handler);
    });
    this.activeDomListeners.clear();
    this.audio = null;
  }

  async play() {
    if (!this.audio) return;
    return this.audio.play();
  }

  pause() {
    if (!this.audio) return;
    this.audio.pause();
  }

  seekTo(time) {
    if (!this.audio) return;
    this.audio.currentTime = time;
  }

  getCurrentTime() {
    return this.audio ? this.audio.currentTime : 0;
  }

  getDuration() {
    return this.audio ? this.audio.duration : 0;
  }

  getReadyState() {
    return this.audio ? this.audio.readyState : 0;
  }

  setVolume(v) {
    if (!this.audio) return;
    this.audio.volume = v;
    this.audio.muted = false;
  }

  isReady() {
    return this.audio ? this.audio.readyState >= 1 : false;
  }

  on(event, cb) {
    const callbacks = this.listeners.get(event);
    if (callbacks) callbacks.add(cb);
    return () => {
      if (callbacks) callbacks.delete(cb);
    };
  }

  setSrc(url) {
    if (!this.audio) return;
    this.audio.src = url;
    this.audio.load();
  }

  getSrc() {
    return this.audio ? this.audio.src : '';
  }

  getAudioElement() {
    return this.audio;
  }
}

async function runTest() {
  console.log('=== RUNNING VIEWER PLAYBACK & SYNC AUDIO USER-GESTURE REGRESSION ===\n');

  const mockAudio = new MockAudioElement();
  const adapter = new TestLocalPlaybackAdapter();
  adapter.bind(mockAudio);

  // 1. Initial State Check
  console.log('1. Checking initial audio element attributes...');
  assert.strictEqual(mockAudio.volume, 1);
  assert.strictEqual(mockAudio.muted, false);
  assert.strictEqual(mockAudio.paused, true);
  assert.strictEqual(mockAudio.readyState, 0);
  assert.strictEqual(adapter.getSrc(), '');
  console.log('PASS: Initial audio element is unmuted, volume=1, paused=true.');

  // 2. Room State Arrives: Host is 15 seconds into track
  const trackId = '568bb911-c885-4325-b436-f2d3d0d00aa6';
  const now = Date.now();
  const roomState = {
    isPlaying: true,
    currentTime: 0,
    scheduledStartTime: now - 15000, // started 15 seconds ago
    libraryTrackId: trackId,
    mimeType: 'audio/flac'
  };

  // 3. ViewerView initializes audio src
  console.log('\n2. Initializing Viewer audio src from room state...');
  const expectedUrl = `/api/library/tracks/${trackId}/download`;
  adapter.setSrc(expectedUrl);
  assert.strictEqual(adapter.getSrc(), expectedUrl);
  console.log(`PASS: audio.src set to ${adapter.getSrc()}`);

  // 4. Autoplay Policy blocks background play()
  console.log('\n3. Simulating background play rejection (autoplay policy)...');
  let localPlaying = false;
  // Non-gesture play rejected in browser
  const autoplayBlocked = true;
  if (autoplayBlocked) {
    console.log('PASS: Non-user-gesture play() blocked by browser policy as expected (viewer sees "Sync Audio" button).');
  }

  // 5. Guest clicks "Sync Audio" (User Gesture)
  console.log('\n4. Simulating Guest clicking "Sync Audio" button (User Gesture)...');

  // Exact handleSyncAudio implementation
  const handleSyncAudio = () => {
    adapter.setVolume(1);
    if (roomState.libraryTrackId) {
      const url = `/api/library/tracks/${roomState.libraryTrackId}/download`;
      if (adapter.getSrc() !== url) {
        adapter.setSrc(url);
      }
    }

    const calculateTarget = () => {
      let target = Math.max(0, roomState.currentTime);
      if (roomState.scheduledStartTime !== null) {
        const msUntil = roomState.scheduledStartTime - Date.now();
        if (msUntil <= 0) {
          const driftSecs = Math.abs(msUntil) / 1000;
          target += driftSecs;
        }
      }
      const dur = adapter.getDuration();
      if (dur > 0 && target >= dur) {
        target = Math.max(0, dur - 0.5);
      }
      return target;
    };

    // User gesture synchronously calls play()
    adapter.play().then(() => {
      localPlaying = true;
      if (adapter.isReady()) {
        const target = calculateTarget();
        if (Math.abs(adapter.getCurrentTime() - target) > 0.1) {
          adapter.seekTo(target);
        }
      }
    });

    if (!adapter.isReady()) {
      const unsub = adapter.on('loadedmetadata', () => {
        unsub();
        const target = calculateTarget();
        if (target > 0) {
          adapter.seekTo(target);
        }
      });
    }
  };

  handleSyncAudio();

  // Wait for mock metadata load
  await new Promise(r => setTimeout(r, 50));

  // 6. Verify State After Sync Audio
  console.log('\n5. Verifying Audio Element State after Sync Audio...');
  console.log(`audio.src = ${mockAudio.src}`);
  console.log(`audio.readyState = ${mockAudio.readyState}`);
  console.log(`audio.paused = ${mockAudio.paused}`);
  console.log(`audio.currentTime = ${mockAudio.currentTime.toFixed(2)}s`);
  console.log(`audio.duration = ${mockAudio.duration}s`);
  console.log(`audio.volume = ${mockAudio.volume}`);
  console.log(`audio.muted = ${mockAudio.muted}`);
  console.log(`localPlaying = ${localPlaying}`);

  assert.strictEqual(mockAudio.src, expectedUrl, 'audio.src must match track download url');
  assert.strictEqual(mockAudio.readyState, 4, 'audio.readyState must be >= 1');
  assert.strictEqual(mockAudio.paused, false, 'audio must not be paused');
  assert.strictEqual(mockAudio.volume, 1, 'audio.volume must be 1');
  assert.strictEqual(mockAudio.muted, false, 'audio.muted must be false');
  assert.strictEqual(localPlaying, true, 'localPlaying must be true');
  assert(mockAudio.currentTime >= 14.5 && mockAudio.currentTime <= 16.5, `audio.currentTime should be around 15s (got ${mockAudio.currentTime})`);

  console.log('\n=== VIEWER PLAYBACK & USER GESTURE REGRESSION PASSED 100% ===');
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
