require('dotenv').config({ path: './.env' });
const { resolveProviderTrack } = require('./src/music/resolver');
const db = require('./src/db');

async function runTest() {
  try {
    await db.initDb();

    console.log('Testing Database Constraint (UNIQUE provider, provider_track_id)...');
    try {
      await db.pool.query(`
        INSERT INTO tracks (id, title, artist, duration, provider, provider_track_id)
        VALUES ('ext_test1', 'Test Track', 'Test Artist', 100, 'spotify', '11dFghVXANMlKmJXsNCbNl')
      `);
      await db.pool.query(`
        INSERT INTO tracks (id, title, artist, duration, provider, provider_track_id)
        VALUES ('ext_test2', 'Test Track', 'Test Artist', 100, 'spotify', '11dFghVXANMlKmJXsNCbNl')
      `);
      console.error('FAIL: Database constraint did not prevent duplicate insertion.');
      process.exit(1);
    } catch (err) {
      if (err.code === '23505') {
        console.log('PASS: Database constraint prevented duplicate insertion correctly.');
      } else {
        console.error('FAIL: Unexpected error during constraint test:', err);
      }
    }

    // Clean up test rows
    await db.pool.query('DELETE FROM tracks WHERE provider_track_id = $1', ['11dFghVXANMlKmJXsNCbNl']);

    console.log('\nTesting Actual Resolver Logic...');
    const fakeSpotifyTrack = {
      provider: 'spotify',
      providerTrackId: 'spotify_real_test_id',
      title: 'Resolved Track',
      artist: 'Resolved Artist',
      duration: 120,
      coverUrl: 'http://example.com/cover.jpg',
      isPlayable: false
    };

    console.log('Call 1 (New Track)...');
    const track1 = await resolveProviderTrack(fakeSpotifyTrack);
    console.log('Result 1 ID:', track1.id);

    console.log('Call 2 (Existing Track)...');
    const track2 = await resolveProviderTrack(fakeSpotifyTrack);
    console.log('Result 2 ID:', track2.id);

    let hasError = false;

    if (track1.id === track2.id) {
      console.log('PASS: Resolver returned the same existing track ID rather than duplicating.');
    } else {
      console.error('FAIL: Resolver created a new track ID instead of returning existing.');
      hasError = true;
    }

    const { rows } = await db.pool.query('SELECT count(*) FROM tracks WHERE provider_track_id = $1', ['spotify_real_test_id']);
    if (parseInt(rows[0].count) === 1) {
      console.log('PASS: Only one track exists in PostgreSQL.');
    } else {
      console.error(`FAIL: PostgreSQL has ${rows[0].count} tracks matching the ID.`);
      hasError = true;
    }

    // Cleanup
    await db.pool.query('DELETE FROM tracks WHERE provider_track_id = $1', ['spotify_real_test_id']);
    
    if (hasError) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Test Execution Error:', err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

runTest();
