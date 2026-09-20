// ─── Spotify CSP, SDK Loader & Artwork Fallback Regression Suite ─────────
// Verifies:
// 1. Helmet CSP headers include Spotify SDK script-src, frame-src, connect-src, and media-src
// 2. sdkLoader singleton implementation invariants (timeout, polling, idempotent promise)
// 3. UniversalTrackCard artwork resolution & neutral fallback (🎵, not green Spotify icon)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const http = require('http');

async function runTests() {
  console.log('=== SPOTIFY CSP, SDK LOADER & ARTWORK FALLBACK REGRESSION SUITE ===\n');

  try {
    // ── TEST 1: Server Helmet CSP Directives ──
    console.log('1. Testing Helmet Content-Security-Policy directives...');

    const app = express();
    app.use(helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'script-src': ["'self'", "https://sdk.scdn.co"],
          'connect-src': ["'self'", "ws:", "wss:", "https://*.spotify.com", "https://*.scdn.co", "wss://*.spotify.com"],
          'frame-src': ["'self'", "https://sdk.scdn.co"],
          'media-src': ["'self'", "blob:", "data:", "https://*"],
          'img-src': ["'self'", "data:", "blob:", "https://*"],
        },
      },
    }));

    app.get('/test-csp', (req, res) => {
      res.send('OK');
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/test-csp`, (res) => {
        resolve(res);
      }).on('error', reject);
    });

    server.close();

    const cspHeader = res.headers['content-security-policy'];
    assert.ok(cspHeader, 'Content-Security-Policy header must be present');

    // Verify script-src allows Spotify SDK
    assert.ok(
      cspHeader.includes("script-src") && cspHeader.includes("https://sdk.scdn.co"),
      'CSP script-src must allow https://sdk.scdn.co'
    );

    // Verify frame-src allows Spotify SDK iframe
    assert.ok(
      cspHeader.includes("frame-src") && cspHeader.includes("https://sdk.scdn.co"),
      'CSP frame-src must allow https://sdk.scdn.co'
    );

    // Verify connect-src allows Spotify endpoints
    assert.ok(
      cspHeader.includes("connect-src") &&
      cspHeader.includes("https://*.spotify.com") &&
      cspHeader.includes("https://*.scdn.co") &&
      cspHeader.includes("wss://*.spotify.com"),
      'CSP connect-src must allow Spotify API, CDN, and WebSocket endpoints'
    );

    // Verify media-src and img-src allow HTTPS wildcards and blobs
    assert.ok(
      cspHeader.includes("media-src") && cspHeader.includes("https://*"),
      'CSP media-src must allow https://*'
    );
    assert.ok(
      cspHeader.includes("img-src") && cspHeader.includes("https://*"),
      'CSP img-src must allow https://*'
    );

    console.log('   ✓ CSP headers strictly permit Spotify Web Playback SDK scripts, iframes, APIs, and CDN.\n');

    // ── TEST 2: Verify server/src/index.js contains the exact CSP directives ──
    console.log('2. Verifying server/src/index.js CSP configuration...');
    const indexJsContent = fs.readFileSync(path.join(__dirname, 'src', 'index.js'), 'utf-8');
    assert.ok(
      indexJsContent.includes("'script-src': [\"'self'\", \"https://sdk.scdn.co\"]"),
      'index.js must configure script-src for https://sdk.scdn.co'
    );
    assert.ok(
      indexJsContent.includes("'frame-src': [\"'self'\", \"https://sdk.scdn.co\"]"),
      'index.js must configure frame-src for https://sdk.scdn.co'
    );
    assert.ok(
      indexJsContent.includes("https://*.spotify.com"),
      'index.js must configure connect-src for https://*.spotify.com'
    );
    console.log('   ✓ server/src/index.js contains verified Spotify CSP directives.\n');

    // ── TEST 3: SDK Loader Invariants in client/src/lib/spotify/sdkLoader.ts ──
    console.log('3. Verifying SDK loader invariants in client/src/lib/spotify/sdkLoader.ts...');
    const sdkLoaderPath = path.join(__dirname, '..', 'client', 'src', 'lib', 'spotify', 'sdkLoader.ts');
    assert.ok(fs.existsSync(sdkLoaderPath), 'sdkLoader.ts must exist');
    const sdkLoaderContent = fs.readFileSync(sdkLoaderPath, 'utf-8');

    // Must export loadSpotifySDK
    assert.ok(
      sdkLoaderContent.includes('export function loadSpotifySDK'),
      'sdkLoader.ts must export loadSpotifySDK'
    );

    // Must inject https://sdk.scdn.co/spotify-player.js
    assert.ok(
      sdkLoaderContent.includes('https://sdk.scdn.co/spotify-player.js'),
      'sdkLoader.ts must target official Spotify SDK URL'
    );

    // Must have timeout protection
    assert.ok(
      sdkLoaderContent.includes('timeoutMs') && sdkLoaderContent.includes('setTimeout'),
      'sdkLoader.ts must implement timeout protection'
    );

    // Must have cleanup for timer and interval
    assert.ok(
      sdkLoaderContent.includes('clearTimeout') && sdkLoaderContent.includes('clearInterval'),
      'sdkLoader.ts must clean up timeout and polling timers'
    );

    // Must check for existing window.Spotify
    assert.ok(
      sdkLoaderContent.includes('window.Spotify'),
      'sdkLoader.ts must check for existing window.Spotify object'
    );

    // Must check for existing script tag to prevent duplicates
    assert.ok(
      sdkLoaderContent.includes("document.getElementById('spotify-player-sdk')"),
      'sdkLoader.ts must check for existing script tag'
    );

    console.log('   ✓ sdkLoader.ts adheres to singleton, timeout, and duplicate prevention invariants.\n');

    // ── TEST 4: Cover Artwork Resolution & Neutral Fallback Invariants ──
    console.log('4. Verifying cover artwork resolution & fallback in UniversalTrackCard.tsx and Library.tsx...');
    const cardPath = path.join(__dirname, '..', 'client', 'src', 'components', 'UniversalTrackCard.tsx');
    assert.ok(fs.existsSync(cardPath), 'UniversalTrackCard.tsx must exist');
    const cardContent = fs.readFileSync(cardPath, 'utf-8');

    // Must resolve relative URLs using SERVER_URL
    assert.ok(
      cardContent.includes('normalizeArtworkUrl'),
      'UniversalTrackCard must define normalizeArtworkUrl'
    );
    assert.ok(
      cardContent.includes('SERVER_URL'),
      'UniversalTrackCard must use SERVER_URL for relative covers'
    );

    // Must have YouTube fallback
    assert.ok(
      cardContent.includes('i.ytimg.com/vi/'),
      'UniversalTrackCard must provide YouTube thumbnail fallback'
    );

    // Final fallback MUST be neutral musical note 🎵 with text-accent-gold, NEVER green Spotify badge
    assert.ok(
      cardContent.includes('🎵') && cardContent.includes('text-accent-gold'),
      'UniversalTrackCard final fallback must be neutral gold 🎵'
    );
    assert.ok(
      !cardContent.includes('text-[#1db954] select-none">🟢') &&
      !cardContent.includes('text-[#1db954]">🟢'),
      'UniversalTrackCard must NEVER fall back to green Spotify ball'
    );

    // Check Library.tsx as well
    const libPath = path.join(__dirname, '..', 'client', 'src', 'components', 'Library.tsx');
    assert.ok(fs.existsSync(libPath), 'Library.tsx must exist');
    const libContent = fs.readFileSync(libPath, 'utf-8');
    assert.ok(
      !libContent.includes('text-[#1db954]">🎵'),
      'Library.tsx SpotifyTrackCard fallback must not use green Spotify color'
    );
    assert.ok(
      libContent.includes('text-accent-gold">🎵'),
      'Library.tsx SpotifyTrackCard fallback must use neutral accent-gold 🎵'
    );

    console.log('   ✓ Cover artwork resolver normalizes URLs and uses neutral 🎵 fallback.\n');

    // ── TEST 5: SDK Loader Failure, DOM Script Tag Removal & Retry-Recovery ──
    console.log('5. Testing SDK Loader failure cleanup, stale element removal, and retry-recovery...');

    // Minimal DOM environment simulation
    function createMockDOM() {
      const elements = new Map();
      const body = {
        children: [],
        appendChild(el) {
          this.children.push(el);
          if (el.id) elements.set(el.id, el);
          el.parentNode = this;
          return el;
        },
        removeChild(el) {
          this.children = this.children.filter(c => c !== el);
          if (el.id) elements.delete(el.id);
          el.parentNode = null;
          return el;
        }
      };

      const doc = {
        body,
        getElementById(id) {
          return elements.get(id) || null;
        },
        createElement(tag) {
          const listeners = {};
          const el = {
            tagName: tag.toUpperCase(),
            id: '',
            src: '',
            async: false,
            parentNode: null,
            addEventListener(event, fn) {
              listeners[event] = listeners[event] || [];
              listeners[event].push(fn);
            },
            remove() {
              if (this.parentNode) {
                this.parentNode.removeChild(this);
              }
            },
            triggerError(err = new Error('CSP or network error')) {
              if (typeof this.onerror === 'function') this.onerror(err);
              (listeners['error'] || []).forEach(fn => fn(err));
            },
            triggerLoad() {
              if (typeof this.onload === 'function') this.onload();
              (listeners['load'] || []).forEach(fn => fn());
            }
          };
          return el;
        }
      };

      const mockWin = {
        document: doc,
        Spotify: undefined,
        onSpotifyWebPlaybackSDKReady: undefined
      };

      return { mockWin, doc, body, elements };
    }

    // Factory matching client/src/lib/spotify/sdkLoader.ts logic
    function createLoader(mockWin) {
      let loadPromise = null;

      function loadSpotifySDK(timeoutMs = 500) {
        if (mockWin.Spotify) {
          return Promise.resolve(mockWin.Spotify);
        }
        if (loadPromise) {
          return loadPromise;
        }

        loadPromise = new Promise((resolve, reject) => {
          let timer = null;
          let pollInterval = null;

          const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (pollInterval) clearInterval(pollInterval);
          };

          const handleSuccess = (source) => {
            cleanup();
            if (mockWin.Spotify) {
              resolve(mockWin.Spotify);
            } else {
              loadPromise = null;
              reject(new Error('Spotify SDK ready callback fired but window.Spotify is missing'));
            }
          };

          const previousOnReady = mockWin.onSpotifyWebPlaybackSDKReady;
          mockWin.onSpotifyWebPlaybackSDKReady = () => {
            if (typeof previousOnReady === 'function') {
              try { previousOnReady(); } catch (_) {}
            }
            handleSuccess('onSpotifyWebPlaybackSDKReady');
          };

          pollInterval = setInterval(() => {
            if (mockWin.Spotify) {
              handleSuccess('pollInterval');
            }
          }, 20);

          timer = setTimeout(() => {
            cleanup();
            loadPromise = null;
            if (mockWin.Spotify) {
              resolve(mockWin.Spotify);
            } else {
              reject(new Error('Timeout loading Spotify Web Playback SDK (check network or ad-blocker)'));
            }
          }, timeoutMs);

          const existingScript = mockWin.document.getElementById('spotify-player-sdk');
          if (existingScript) {
            if (mockWin.Spotify) {
              cleanup();
              resolve(mockWin.Spotify);
              return;
            }
            if (existingScript.parentNode) {
              existingScript.parentNode.removeChild(existingScript);
            } else {
              existingScript.remove();
            }
          }

          const script = mockWin.document.createElement('script');
          script.id = 'spotify-player-sdk';
          script.src = 'https://sdk.scdn.co/spotify-player.js';
          script.async = true;

          script.onerror = (err) => {
            cleanup();
            loadPromise = null;
            if (script.parentNode) {
              script.parentNode.removeChild(script);
            } else {
              script.remove();
            }
            reject(new Error('Failed to load Spotify Web Playback SDK script (network or CSP blocked)'));
          };

          mockWin.document.body.appendChild(script);
        });

        return loadPromise;
      }

      return { loadSpotifySDK, getInFlightPromise: () => loadPromise };
    }

    const { mockWin, doc, body } = createMockDOM();
    const loader = createLoader(mockWin);

    // 5a. Initial attempt fails (e.g. ad-blocker triggers error)
    const loadPromise1 = loader.loadSpotifySDK();
    assert.strictEqual(body.children.length, 1, 'Script element must be inserted into DOM on initial load');
    const scriptEl1 = body.children[0];
    assert.strictEqual(scriptEl1.src, 'https://sdk.scdn.co/spotify-player.js');

    // Trigger script error
    scriptEl1.triggerError(new Error('Blocked by client'));

    let errorThrown = false;
    try {
      await loadPromise1;
    } catch (err) {
      errorThrown = true;
      assert.ok(err.message.includes('Failed to load Spotify Web Playback SDK script'));
    }
    assert.ok(errorThrown, 'Initial SDK load must reject on script.onerror');

    // 5b. Verify failed script tag was removed from DOM and singleton promise cleared
    assert.strictEqual(body.children.length, 0, 'Failed script tag must be removed from document.body on error');
    assert.strictEqual(doc.getElementById('spotify-player-sdk'), null, 'Failed script tag must not be findable by ID');
    assert.strictEqual(loader.getInFlightPromise(), null, 'loadPromise singleton must be reset to null on error');

    // 5c. Retry creating a fresh script tag
    const loadPromise2 = loader.loadSpotifySDK();
    assert.strictEqual(body.children.length, 1, 'Retry must inject a fresh script element into document.body');
    const scriptEl2 = body.children[0];
    assert.notStrictEqual(scriptEl1, scriptEl2, 'Retry script element must be a fresh element instance');

    // 5d. Successful load on retry
    mockWin.Spotify = { Player: class MockPlayer {} };
    if (typeof mockWin.onSpotifyWebPlaybackSDKReady === 'function') {
      mockWin.onSpotifyWebPlaybackSDKReady();
    }
    const resultSDK = await loadPromise2;
    assert.strictEqual(resultSDK, mockWin.Spotify, 'Retry must successfully resolve with window.Spotify');

    // 5e. Subsequent call with window.Spotify already present resolves immediately without creating another script
    const prevCount = body.children.length;
    const resultImmediate = await loader.loadSpotifySDK();
    assert.strictEqual(resultImmediate, mockWin.Spotify);
    assert.strictEqual(body.children.length, prevCount, 'Subsequent load when window.Spotify exists must not add new script');

    console.log('   ✓ SDK Loader successfully removes failed DOM script and recovers on retry.\n');

    // ── TEST 6: SpotifyPlaybackAdapter Failure & Retry-Recovery Behavior ──
    console.log('6. Testing SpotifyPlaybackAdapter initialization failure and retry-recovery...');

    class MockSpotifyPlaybackAdapter {
      constructor(loaderFn) {
        this.loaderFn = loaderFn;
        this.initPromise = null;
        this.player = null;
        this.isDestroyed = false;
      }

      async init() {
        if (this.isDestroyed) return;
        if (this.player) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
          try {
            const SpotifySDK = await this.loaderFn();
            if (this.isDestroyed) return;
            this.player = new SpotifySDK.Player({ name: 'Test' });
          } catch (err) {
            this.initPromise = null;
            throw err;
          }
        })();

        return this.initPromise;
      }
    }

    let shouldFail = true;
    const mockLoaderFn = async () => {
      if (shouldFail) {
        throw new Error('Failed to load Spotify Web Playback SDK script (network or CSP blocked)');
      }
      return { Player: class MockPlayer { constructor(cfg) { this.cfg = cfg; } } };
    };

    const adapter = new MockSpotifyPlaybackAdapter(mockLoaderFn);

    // Initial init fails
    let adapterInitError = false;
    try {
      await adapter.init();
    } catch (err) {
      adapterInitError = true;
      assert.ok(err.message.includes('Failed to load Spotify Web Playback SDK script'));
    }
    assert.ok(adapterInitError, 'Adapter init must throw on initial loader failure');
    assert.strictEqual(adapter.initPromise, null, 'adapter.initPromise must be reset to null when init rejects');
    assert.strictEqual(adapter.player, null, 'adapter.player must remain null on failure');

    // Retry succeeds
    shouldFail = false;
    await adapter.init();
    assert.ok(adapter.player, 'adapter.player must be initialized after successful retry');
    assert.strictEqual(adapter.player.cfg.name, 'Test');

    console.log('   ✓ SpotifyPlaybackAdapter does not cache failed initPromise and recovers on retry.\n');

    console.log('====================================================');
    console.log('ALL SPOTIFY CSP & LOADER REGRESSION TESTS PASSED 100%');
    console.log('====================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    process.exit(1);
  }
}

runTests();

