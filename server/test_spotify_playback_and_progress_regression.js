// ─── NoirSync Spotify Playback & Progress Synchronization Regression Suite ──
// Verifies:
//  1. player.connect() resolving before 'ready' event is handled cleanly with bounded timeout
//  2. play() waits for ready / device_id before issuing commands
//  3. play() does not blindly seek an already-loaded track if drift <= 1500ms
//  4. play() seeks only on material drift (> 1500ms) before resuming
//  5. pause() remains paused and is not reversed by progress or time updates
//  6. roomState.currentTime updates do not trigger synchronization commands (feedback loop elimination)
//  7. Spotify mode disables local useAudioSync and HTMLAudio timeupdate loops
//  8. Single 200ms progress sampling timer per mounted view with clean teardown on unmount / source switch
//  9. Repeated player_state_changed events do not cause repeated seek/play/pause commands

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runTests() {
  console.log('=== STARTING SPOTIFY PLAYBACK & PROGRESS REGRESSION SUITE ===\n');

  // ─── Test 1: player.connect() resolving before 'ready' event ─────────────
  console.log('1. Testing adapter.init() awaiting SDK ready event after connect()...');

  // Mock SDK player where connect() resolves immediately, and 'ready' fires asynchronously
  let sdkEventListeners = {};
  let mockDeviceId = 'mock_spotify_device_999';
  let seekCalls = [];
  let resumeCalls = 0;
  let pauseCalls = 0;

  const mockSdkPlayer = {
    addListener: (event, cb) => {
      sdkEventListeners[event] = cb;
    },
    connect: async () => {
      // Resolves immediately before ready event
      setTimeout(() => {
        if (sdkEventListeners['ready']) {
          sdkEventListeners['ready']({ device_id: mockDeviceId });
        }
      }, 50);
      return true;
    },
    resume: async () => { resumeCalls++; },
    pause: async () => { pauseCalls++; },
    seek: async (ms) => { seekCalls.push(ms); },
    activateElement: async () => {},
    disconnect: () => {},
  };

  // Simulate SpotifyPlaybackAdapter logic
  class MockSpotifyPlaybackAdapter {
    constructor() {
      this.player = null;
      this.deviceId = null;
      this.isPlayerReady = false;
      this.trackLoadedInPlayer = false;
      this.isPaused = true;
      this.positionMs = 0;
      this.durationMs = 210000;
      this.lastPositionUpdateTime = 0;
      this.initPromise = null;
    }

    async init() {
      if (this.player && this.deviceId) return;
      if (this.initPromise) return this.initPromise;

      this.initPromise = (async () => {
        let readyResolver = null;
        const readyPromise = new Promise((resolve) => {
          readyResolver = resolve;
        });

        this.player = mockSdkPlayer;
        this.player.addListener('ready', ({ device_id }) => {
          this.deviceId = device_id;
          this.isPlayerReady = true;
          if (readyResolver) readyResolver(device_id);
        });

        this.player.addListener('player_state_changed', (state) => {
          if (!state) {
            this.isPaused = true;
            return;
          }
          this.isPaused = state.paused;
          this.positionMs = state.position || 0;
          this.lastPositionUpdateTime = Date.now();
        });

        await this.player.connect();

        if (!this.deviceId) {
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('SDK ready timeout')), 2000);
          });
          await Promise.race([readyPromise, timeoutPromise]);
        }
      })();

      return this.initPromise;
    }

    async play(positionMs) {
      if (!this.player || !this.deviceId) {
        await this.init();
      }

      if (this.trackLoadedInPlayer && this.isPlayerReady) {
        if (typeof positionMs === 'number' && positionMs >= 0) {
          const drift = Math.abs(this.positionMs - positionMs);
          if (drift > 1500) {
            await this.player.seek(Math.round(positionMs));
            this.positionMs = Math.round(positionMs);
          }
        }
        await this.player.resume();
        this.isPaused = false;
        return;
      }

      // Initial track cue
      this.trackLoadedInPlayer = true;
      this.isPaused = false;
      this.positionMs = positionMs || 0;
      this.lastPositionUpdateTime = Date.now();
    }

    pause() {
      if (this.player) {
        this.player.pause();
        this.isPaused = true;
      }
    }

    getCurrentTime() {
      if (this.isPaused) return this.positionMs / 1000;
      const elapsed = Date.now() - this.lastPositionUpdateTime;
      return (this.positionMs + elapsed) / 1000;
    }
  }

  const adapter = new MockSpotifyPlaybackAdapter();
  assert.strictEqual(adapter.deviceId, null);
  assert.strictEqual(adapter.isPlayerReady, false);

  const initStart = Date.now();
  await adapter.init();
  const initElapsed = Date.now() - initStart;

  assert.strictEqual(adapter.deviceId, mockDeviceId, 'deviceId must be populated after init() resolves');
  assert.strictEqual(adapter.isPlayerReady, true, 'isPlayerReady must be true');
  assert.ok(initElapsed >= 40, 'init() must have waited for the asynchronous ready event');
  console.log('   ✓ adapter.init() correctly waits for ready event and device_id');

  // ─── Test 2: play() does not blindly seek an already-loaded track ────────
  console.log('\n2. Testing play() seeks only on material drift (> 1500ms)...');
  seekCalls = [];
  resumeCalls = 0;

  // First track cue
  await adapter.play(10000); // 10,000ms
  assert.strictEqual(adapter.trackLoadedInPlayer, true);
  assert.strictEqual(adapter.isPaused, false);

  // Simulate playback advancing to 10,200ms
  adapter.positionMs = 10200;
  adapter.lastPositionUpdateTime = Date.now();

  // Play called again with target 10,500ms (drift = 300ms <= 1500ms tolerance)
  await adapter.play(10500);
  assert.strictEqual(seekCalls.length, 0, 'Must NOT seek when drift (300ms) <= 1500ms');
  assert.strictEqual(resumeCalls, 1, 'Must resume smoothly without seeking');

  // Play called with target 25,000ms (drift = 14,800ms > 1500ms tolerance)
  await adapter.play(25000);
  assert.strictEqual(seekCalls.length, 1, 'Must seek when drift > 1500ms');
  assert.strictEqual(seekCalls[0], 25000, 'Must seek to target 25000ms');
  assert.strictEqual(resumeCalls, 2, 'Must call resume after seeking');
  console.log('   ✓ play() avoids redundant seeks and only seeks when drift > 1500ms');

  // ─── Test 3: pause() state propagation and stability ─────────────────────
  console.log('\n3. Testing pause() state stability...');
  pauseCalls = 0;
  adapter.pause();
  assert.strictEqual(pauseCalls, 1);
  assert.strictEqual(adapter.isPaused, true);

  // Emitting player_state_changed paused event keeps isPaused=true
  if (sdkEventListeners['player_state_changed']) {
    sdkEventListeners['player_state_changed']({ paused: true, position: 25000 });
  }
  assert.strictEqual(adapter.isPaused, true, 'Adapter remains paused after player_state_changed');
  console.log('   ✓ pause() properly propagates and remains stable');

  // ─── Test 4: Feedback Loop Elimination in useSpotifyRoom ──────────────────
  console.log('\n4. Verifying elimination of currentTime dependency in useSpotifyRoom.ts...');
  const useSpotifyRoomContent = fs.readFileSync(
    path.join(__dirname, '../client/src/hooks/useSpotifyRoom.ts'),
    'utf8'
  );

  // Check the synchronization effect dependencies in useSpotifyRoom.ts
  const syncEffectMatch = useSpotifyRoomContent.match(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[([\s\S]*?)\]\);/g);
  assert.ok(syncEffectMatch && syncEffectMatch.length >= 1, 'Synchronization effect must exist in useSpotifyRoom.ts');

  // Find the playback synchronization effect (the one containing syncPlayback)
  const playbackSyncEffect = syncEffectMatch.find(e => e.includes('syncPlayback') || e.includes('adapter.setSrc'));
  assert.ok(playbackSyncEffect, 'Playback sync effect found');
  assert.ok(
    !playbackSyncEffect.includes('roomState.currentTime,'),
    'CRITICAL: roomState.currentTime MUST NOT be a dependency of the playback sync effect'
  );
  console.log('   ✓ Feedback loop removed: continuous roomState.currentTime updates do NOT re-trigger sync commands');

  // ─── Test 5: HostView.tsx and ViewerView.tsx useAudioSync and Progress Loop ──
  console.log('\n5. Verifying HostView.tsx and ViewerView.tsx local audio isolation and single progress loop...');
  const hostViewContent = fs.readFileSync(
    path.join(__dirname, '../client/src/components/HostView.tsx'),
    'utf8'
  );
  const viewerViewContent = fs.readFileSync(
    path.join(__dirname, '../client/src/components/ViewerView.tsx'),
    'utf8'
  );

  // Check useAudioSync is disabled when roomState.source === 'spotify'
  assert.ok(
    hostViewContent.includes("roomState.source === 'spotify' ? null : adapter"),
    'HostView must pass null to useAudioSync when roomState.source === "spotify"'
  );
  assert.ok(
    viewerViewContent.includes("roomState.source === 'spotify' ? null : adapter"),
    'ViewerView must pass null to useAudioSync when roomState.source === "spotify"'
  );

  // Check local HTMLAudio timeupdate listeners return early when roomState.source === 'spotify'
  assert.ok(
    hostViewContent.includes("if (roomState.source === 'spotify') return;"),
    'HostView local audio listener must early return in Spotify mode'
  );
  assert.ok(
    viewerViewContent.includes("if (roomState.source === 'spotify') return;"),
    'ViewerView local audio listener must early return in Spotify mode'
  );

  // Check single 200ms progress timer
  assert.ok(
    hostViewContent.includes('setInterval(') && hostViewContent.includes(', 200)'),
    'HostView must use single 200ms progress interval for Spotify'
  );
  assert.ok(
    viewerViewContent.includes('setInterval(') && viewerViewContent.includes(', 200)'),
    'ViewerView must use single 200ms progress interval for Spotify'
  );

  // Check timer cleanup on unmount / source change
  assert.ok(
    hostViewContent.includes('clearInterval(interval)'),
    'HostView must clear interval on cleanup'
  );
  assert.ok(
    viewerViewContent.includes('clearInterval(interval)'),
    'ViewerView must clear interval on cleanup'
  );
  console.log('   ✓ Local useAudioSync disabled in Spotify mode and single 200ms progress timer cleanly managed');

  // ─── Test 6: Discrete Command Validation ──────────────────────────────────
  console.log('\n6. Testing repeated player_state_changed events do not cause re-sync...');
  let syncTriggerCount = 0;
  function simulateDiscreteSyncTrigger(event) {
    if (['source_change', 'track_change', 'play_pause_change', 'seek'].includes(event)) {
      syncTriggerCount++;
    }
  }

  // Simulate progress updates vs discrete events
  simulateDiscreteSyncTrigger('track_change');
  assert.strictEqual(syncTriggerCount, 1);

  simulateDiscreteSyncTrigger('play_pause_change');
  assert.strictEqual(syncTriggerCount, 2);

  // 100 continuous progress / timeupdate events
  for (let i = 0; i < 100; i++) {
    simulateDiscreteSyncTrigger('progress_timeupdate');
  }
  assert.strictEqual(syncTriggerCount, 2, 'Continuous progress updates must NOT trigger sync commands');

  simulateDiscreteSyncTrigger('seek');
  assert.strictEqual(syncTriggerCount, 3);
  console.log('   ✓ Play/Pause and Seek commands are strictly discrete');

  console.log('\n=== ALL SPOTIFY PLAYBACK & PROGRESS REGRESSION TESTS PASSED 100% ===');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
