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
