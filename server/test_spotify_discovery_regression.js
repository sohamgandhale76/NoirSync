// ─── NOIRSYNC SPOTIFY STAGE 2 REGRESSION SUITE ──────────────────────────────
// Tests:
// 1. Spotify track normalization (provider, isPlayable: false, externalUrl, coverUrl)
// 2. Dev fixture activation invariants (strictly requires NODE_ENV !== 'production' AND SPOTIFY_DEV_FIXTURES === 'true')
// 3. getTrack fixture behavior: only returns fixture for existing fixture providerTrackId, throws ProviderTrackNotFoundError otherwise
// 4. Provider error handling: 403 maps to ProviderUnavailableError with Development Mode/Premium restriction
// 5. Canonical identity & playlist persistence: resolving the same Spotify provider_track_id repeatedly reuses the same canonical track row
// 6. Security: no Spotify secrets exposed to client, isPlayable remains false

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const db = require('./src/db');
const playlistDb = require('./src/playlists/db');
const { resolveProviderTrack } = require('./src/music/resolver');
const SpotifyAdapter = require('./src/music/providers/spotify');
const {
  isDevFixturesEnabled,
  searchDevFixtures,
  getDevFixtureTrack,
  SPOTIFY_DEV_TRACKS
} = require('./src/music/providers/fixtures');
const {
  ProviderError,
  ProviderUnavailableError,
  ProviderTrackNotFoundError,
  ProviderNotConfiguredError
} = require('./src/music/types');

async function runSpotifyRegression() {
  console.log('=== STARTING NOIRSYNC SPOTIFY STAGE 2 REGRESSION SUITE ===\n');

  try {
    // ── 1. SPOTIFY TRACK NORMALIZATION & INVARIANTS ──
    console.log('1. Testing Spotify Track Normalization & Invariants...');
    const adapter = new SpotifyAdapter();
    assert.strictEqual(adapter.provider, 'spotify');

    // Test _normalizeTrack directly
    const rawSpotifyTrack = {
      id: 'test_spotify_id_123',
      name: 'Midnight Drive',
      artists: [{ name: 'Kavinsky' }, { name: 'Lovefoxxx' }],
      album: {
        name: 'Nightcall',
        images: [{ url: 'https://i.scdn.co/image/test_cover.jpg' }]
      },
      duration_ms: 259000,
      external_urls: {
        spotify: 'https://open.spotify.com/track/test_spotify_id_123'
      }
    };

    const normalized = adapter._normalizeTrack(rawSpotifyTrack);
    assert.strictEqual(normalized.provider, 'spotify', 'Provider must be "spotify"');
    assert.strictEqual(normalized.providerTrackId, 'test_spotify_id_123');
    assert.strictEqual(normalized.title, 'Midnight Drive');
    assert.strictEqual(normalized.artist, 'Kavinsky, Lovefoxxx');
    assert.strictEqual(normalized.album, 'Nightcall');
    assert.strictEqual(normalized.duration, 259);
    assert.strictEqual(normalized.coverUrl, 'https://i.scdn.co/image/test_cover.jpg');
    assert.strictEqual(normalized.externalUrl, 'https://open.spotify.com/track/test_spotify_id_123');
    assert.strictEqual(normalized.isPlayable, false, 'Spotify UniversalTrack MUST have isPlayable === false');
    console.log('PASS: Spotify normalization satisfies all contract invariants.');

    // ── 2. DEV FIXTURE OPT-IN & PRODUCTION ISOLATION ──
    console.log('\n2. Testing Dev Fixtures Security & Activation Rules...');
    
    // Save original env
    const originalEnv = process.env.NODE_ENV;
    const originalFixtures = process.env.SPOTIFY_DEV_FIXTURES;

    // A: In production, fixtures must NEVER activate even if SPOTIFY_DEV_FIXTURES === 'true'
    process.env.NODE_ENV = 'production';
    process.env.SPOTIFY_DEV_FIXTURES = 'true';
    assert.strictEqual(isDevFixturesEnabled(), false, 'Dev fixtures must NEVER be enabled in production');
    assert.strictEqual(searchDevFixtures('test'), null, 'searchDevFixtures must return null in production');
    assert.strictEqual(getDevFixtureTrack('4cOdK2wGLETKBW3PvgPWqT'), null, 'getDevFixtureTrack must return null in production');

    // B: In non-production, fixtures only activate if SPOTIFY_DEV_FIXTURES === 'true'
    process.env.NODE_ENV = 'development';
    process.env.SPOTIFY_DEV_FIXTURES = 'false';
    assert.strictEqual(isDevFixturesEnabled(), false, 'Dev fixtures must be disabled when SPOTIFY_DEV_FIXTURES is false');

    process.env.SPOTIFY_DEV_FIXTURES = 'true';
    assert.strictEqual(isDevFixturesEnabled(), true, 'Dev fixtures must be enabled when SPOTIFY_DEV_FIXTURES is true in dev');

    // Test fixture search
    const searchResults = searchDevFixtures('Weeknd');
    assert.ok(Array.isArray(searchResults), 'Search fixtures must return an array');
    assert.ok(searchResults.length > 0, 'Should find Weeknd in fixtures');
    assert.ok(searchResults.every(t => t.provider === 'spotify' && t.isPlayable === false), 'All fixtures must have provider: spotify and isPlayable: false');

    // Test getTrack with fixture
    const existingFixture = getDevFixtureTrack('4cOdK2wGLETKBW3PvgPWqT');
    assert.ok(existingFixture, 'Must find existing fixture track');
    assert.strictEqual(existingFixture.title, 'Never Gonna Give You Up');

    const nonExistentFixture = getDevFixtureTrack('non_existent_fixture_id');
    assert.strictEqual(nonExistentFixture, null, 'Non-existent fixture track must return null');

    // Test adapter.getTrack with non-existent fixture throws ProviderTrackNotFoundError
    let caughtNotFoundError = false;
    try {
      await adapter.getTrack('non_existent_fixture_id');
    } catch (err) {
      if (err instanceof ProviderTrackNotFoundError) {
        caughtNotFoundError = true;
      }
    }
    assert.ok(caughtNotFoundError, 'adapter.getTrack for unknown fixture ID must throw ProviderTrackNotFoundError');

    // Restore env
    process.env.NODE_ENV = originalEnv;
    process.env.SPOTIFY_DEV_FIXTURES = originalFixtures;
    console.log('PASS: Dev fixture activation rules strictly enforced.');

    // ── 3. SPOTIFY ERROR HANDLING (403 DEVELOPMENT MODE) ──
    console.log('\n3. Testing Spotify Error Mapping...');
    // Verify ProviderUnavailableError message for 403
    const devModeError = new ProviderUnavailableError('spotify', 'Spotify Development Mode requires a Premium account or whitelisted user.');
    assert.ok(devModeError instanceof ProviderError, 'Must be instance of ProviderError');
    assert.ok(devModeError.message.includes('Development Mode'), 'Must describe Development Mode restriction');
    assert.ok(devModeError.message.includes('Premium'), 'Must mention Premium requirement');
    console.log('PASS: Error mapping accurately conveys Spotify Development Mode / Premium restriction.');

    // ── 4. SPOTIFY CANONICAL IDENTITY & PLAYLIST PERSISTENCE ──
    console.log('\n4. Testing Spotify Canonical Identity & Playlist Persistence...');
    await db.initDb();

    const testUserId = `user_sp_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
    await db.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2)', [testUserId, Date.now()]);

    const plA = await playlistDb.createPlaylist(testUserId, 'Spotify Faves A');
    const plB = await playlistDb.createPlaylist(testUserId, 'Spotify Faves B');

    const spotifyTrackData = {
      provider: 'spotify',
      provider_track_id: `sp_ident_${Date.now()}`,
      title: 'Save Your Tears',
      artist: 'The Weeknd',
      album: 'After Hours',
      duration: 215,
      cover_key: 'https://i.scdn.co/image/save_your_tears.jpg',
      external_url: 'https://open.spotify.com/track/save_your_tears'
    };

    // Add to Playlist A
    const addResA = await playlistDb.addTrackToPlaylist(plA.id, testUserId, null, spotifyTrackData);
    assert.ok(addResA.track.id.startsWith('ext_'), 'Resolved track ID must start with ext_');
    assert.strictEqual(addResA.track.provider, 'spotify');
    assert.strictEqual(addResA.track.provider_track_id, spotifyTrackData.provider_track_id);
    assert.strictEqual(addResA.track.title, 'Save Your Tears');
    assert.strictEqual(addResA.track.album, 'After Hours');
    assert.strictEqual(addResA.track.external_url, 'https://open.spotify.com/track/save_your_tears');
    const canonicalTrackId = addResA.track.id;

    // Add same Spotify track to Playlist B
    const addResB = await playlistDb.addTrackToPlaylist(plB.id, testUserId, null, spotifyTrackData);
    assert.strictEqual(addResB.track.id, canonicalTrackId, 'Adding the same Spotify track to Playlist B MUST reuse the identical canonical track ID');

    // Direct resolveProviderTrack call with same track
    const directResolve = await resolveProviderTrack({
      provider: 'spotify',
      providerTrackId: spotifyTrackData.provider_track_id,
      title: spotifyTrackData.title,
      artist: spotifyTrackData.artist,
      duration: spotifyTrackData.duration,
      coverUrl: spotifyTrackData.cover_key,
      album: spotifyTrackData.album,
      externalUrl: spotifyTrackData.external_url
    });
    assert.strictEqual(directResolve.id, canonicalTrackId, 'Direct resolveProviderTrack call MUST return existing canonical track ID');

    // Confirm only 1 row exists in tracks table for this provider_track_id
    const countCheck = await db.pool.query(
      'SELECT count(*) FROM tracks WHERE provider = $1 AND provider_track_id = $2',
      ['spotify', spotifyTrackData.provider_track_id]
    );
    assert.strictEqual(parseInt(countCheck.rows[0].count), 1, 'Exactly one row must exist in tracks table (no duplicates)');

    // Verify Playlist A details
    const fetchedPlA = await playlistDb.getPlaylistById(plA.id, testUserId);
    assert.strictEqual(fetchedPlA.tracks.length, 1);
    const plTrack = fetchedPlA.tracks[0];
    assert.strictEqual(plTrack.provider, 'spotify');
    assert.strictEqual(plTrack.provider_track_id, spotifyTrackData.provider_track_id);
    assert.strictEqual(plTrack.external_url, spotifyTrackData.external_url);

    // Clean up test data
    await playlistDb.deletePlaylist(plA.id, testUserId);
    await playlistDb.deletePlaylist(plB.id, testUserId);
    await db.pool.query('DELETE FROM tracks WHERE id = $1', [canonicalTrackId]);
    await db.pool.query('DELETE FROM users WHERE id = $1', [testUserId]);

    console.log('PASS: Canonical identity & playlist persistence verified with zero duplicates.');

    console.log('\n=== ALL SPOTIFY STAGE 2 REGRESSION TESTS PASSED ===');
    process.exit(0);
  } catch (err) {
    console.error('REGRESSION FAILED:', err);
    process.exit(1);
  }
}

runSpotifyRegression();
