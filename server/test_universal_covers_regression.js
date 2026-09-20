// ─── Universal Music Cover Artwork Regression Suite ──────────────────────────
// Verifies all 5 required invariants for cover artwork across providers and catalog:
// 1. Spotify dev fixture returns valid CDN cover URL.
// 2. YouTube adapter returns valid thumbnail URL.
// 3. formatUniversalTrack generates standard YouTube thumbnail for YouTube tracks.
// 4. searchCatalog enriches DB tracks lacking covers (or with truncated covers) with live provider artwork.
// 5. NoirSync public catalog tracks generate valid cover URLs (/api/catalog/tracks/:id/cover or direct HTTP).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const { pool, initDb, insertTrack } = require('./src/db');
const catalogDb = require('./src/catalog/db');
const { getMusicProvider } = require('./src/music/registry');

async function runTests() {
  console.log('=== UNIVERSAL MUSIC COVER ARTWORK REGRESSION SUITE ===\n');

  try {
    await initDb();
    const runId = Date.now();

    // ── TEST 1: Spotify dev fixture returns valid CDN cover URL ──
    console.log('1. Testing Spotify dev fixture cover artwork...');
    const spotifyAdapter = getMusicProvider('spotify');
    const spotifyResults = await spotifyAdapter.search('Rick');
    assert.ok(Array.isArray(spotifyResults) && spotifyResults.length > 0, 'Spotify search must return fixture results');
    const rickTrack = spotifyResults.find(t => t.title.includes('Never Gonna Give You Up'));
    assert.ok(rickTrack, 'Must find Rick Astley track');
    assert.ok(rickTrack.coverUrl, 'Spotify fixture track must have coverUrl');
    assert.ok(
      rickTrack.coverUrl.startsWith('https://i.scdn.co/image/'),
      `coverUrl must be official Spotify CDN, got: ${rickTrack.coverUrl}`
    );
    assert.strictEqual(
      rickTrack.coverUrl,
      'https://i.scdn.co/image/ab67616d0000b2735755e164993798e0c9ef7d7a',
      'coverUrl must match valid fixture hash'
    );
    console.log('   ✓ Spotify dev fixture provides valid CDN cover URL.\n');

    // ── TEST 2: YouTube adapter returns valid thumbnail URL in non-production ──
    console.log('2. Testing YouTube adapter thumbnail URL...');
    const ytAdapter = getMusicProvider('youtube');
    const ytTrack = await ytAdapter.getTrack('yt_dQw4w9WgXcQ');
    assert.ok(ytTrack, 'YouTube getTrack must return track for yt_* fixture');
    assert.ok(ytTrack.coverUrl, 'YouTube track must include coverUrl');
    assert.strictEqual(
      ytTrack.coverUrl,
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      'YouTube coverUrl must be standard YouTube thumbnail URL'
    );
    console.log('   ✓ YouTube adapter provides valid thumbnail URL.\n');

    // ── TEST 3: formatUniversalTrack generates thumbnail for YouTube tracks without cover ──
    console.log('3. Testing formatUniversalTrack YouTube thumbnail generation...');
    const formattedYt = catalogDb.formatUniversalTrack({
      id: `ext_yt_${runId}`,
      provider: 'youtube',
      provider_track_id: '9bZkp7q19f0',
      title: 'Gangnam Style',
      artist: 'PSY',
      cover_key: null,
      publication_status: 'published'
    });
    assert.ok(formattedYt, 'formatUniversalTrack must format track');
    assert.strictEqual(
      formattedYt.coverUrl,
      'https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg',
      'YouTube tracks without cover must receive standard YouTube thumbnail'
    );
    console.log('   ✓ formatUniversalTrack generates standard YouTube thumbnail.\n');

    // ── TEST 4: searchCatalog enriches DB row lacking cover with live provider artwork ──
    console.log('4. Testing searchCatalog artwork enrichment (DB row + live provider)...');
    // Insert a DB row that has no cover_key
    const spotFixtureId = '4cOdK2wGLETKBW3PvgPWqT'; // Rick Astley
    const testDbTrack = await insertTrack({
      id: `ext_spot_nocover_${runId}`,
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      duration: 213,
      provider: 'spotify',
      provider_track_id: spotFixtureId,
      cover_key: null, // intentionally missing in DB!
      publication_status: 'published',
      user_id: null
    });

    const searchRes = await catalogDb.searchCatalog({ query: 'Never Gonna Give You Up', provider: 'spotify' });
    const matchedTrack = searchRes.tracks.find(t => t.providerTrackId === spotFixtureId);
    assert.ok(matchedTrack, 'Must find track in search results');
    assert.strictEqual(matchedTrack.id, testDbTrack.id, 'Must preserve canonical DB tracks.id');
    assert.ok(matchedTrack.coverUrl, 'Search result must be enriched with live provider coverUrl');
    assert.strictEqual(
      matchedTrack.coverUrl,
      'https://i.scdn.co/image/ab67616d0000b2735755e164993798e0c9ef7d7a',
      'coverUrl must be enriched from live provider fixture'
    );
    console.log('   ✓ DB track without cover was enriched with live provider artwork.\n');

    // ── TEST 5: Public NoirSync catalog tracks generate valid cover URL ──
    console.log('5. Testing NoirSync public catalog track cover URL...');
    const publicTrack = await insertTrack({
      id: `pub_track_${runId}`,
      title: 'NoirSync Public Anthem',
      artist: 'NoirSync Choir',
      duration: 180,
      provider: 'noirsync_public',
      provider_track_id: `pub_anthem_${runId}`,
      cover_key: `covers/public_anthem_${runId}.jpg`,
      audio_key: `audio/public_anthem_${runId}.mp3`,
      publication_status: 'published',
      user_id: null
    });

    const formattedPub = catalogDb.formatUniversalTrack(publicTrack);
    assert.strictEqual(
      formattedPub.coverUrl,
      `/api/catalog/tracks/${publicTrack.id}/cover`,
      'Relative cover URL must be correctly formatted for public tracks'
    );
    console.log('   ✓ NoirSync public catalog track generates correct cover URL endpoint.\n');

    console.log('======================================================');
    console.log('ALL 5 UNIVERSAL COVER ARTWORK REGRESSION TESTS PASSED!');
    console.log('======================================================\n');
  } catch (err) {
    console.error('REGRESSION FAILURE:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runTests();
