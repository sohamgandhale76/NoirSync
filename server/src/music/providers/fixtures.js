/**
 * Dev-only fixtures for Spotify metadata search and track retrieval.
 * STRICTLY for testing/development when Spotify Developer Mode returns 403 or credentials are unconfigured.
 * MUST NEVER activate in production.
 */

const SPOTIFY_DEV_TRACKS = [
  {
    provider: 'spotify',
    providerTrackId: '4cOdK2wGLETKBW3PvgPWqT',
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley',
    album: 'Whenever You Need Somebody',
    duration: 213,
    coverUrl: 'https://i.scdn.co/image/ab67616d0000b2735755e164993798e0c9ef7d7a',
    externalUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
    isPlayable: false
  },
  {
    provider: 'spotify',
    providerTrackId: '0VjIjW4GlUZAMYd2vXMi3b',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    album: 'After Hours',
    duration: 200,
    coverUrl: 'https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36',
    externalUrl: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
    isPlayable: false
  },
  {
    provider: 'spotify',
    providerTrackId: '2b8XmlPox6x9v1MmqaOGAG',
    title: 'Starboy',
    artist: 'The Weeknd, Daft Punk',
    album: 'Starboy',
    duration: 230,
    coverUrl: 'https://i.scdn.co/image/ab67616d0000b2734718e2b124f79258be7bc452',
    externalUrl: 'https://open.spotify.com/track/2b8XmlPox6x9v1MmqaOGAG',
    isPlayable: false
  },
  {
    provider: 'spotify',
    providerTrackId: '6I9VzXrHxO9rA9A5euc8Aq',
    title: 'Get Lucky',
    artist: 'Daft Punk, Pharrell Williams, Nile Rodgers',
    album: 'Random Access Memories',
    duration: 369,
    coverUrl: 'https://i.scdn.co/image/ab67616d0000b2739b6ac98a52f64d500993d395',
    externalUrl: 'https://open.spotify.com/track/6I9VzXrHxO9rA9A5euc8Aq',
    isPlayable: false
  },
  {
    provider: 'spotify',
    providerTrackId: '3n3Ppam7vgaVa1iaRUc9Lp',
    title: 'Mr. Brightside',
    artist: 'The Killers',
    album: 'Hot Fuss',
    duration: 222,
    coverUrl: 'https://i.scdn.co/image/ab67616d0000b273cc3623910c71c4c1d43a2bc0',
    externalUrl: 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp',
    isPlayable: false
  },
  {
    provider: 'spotify',
    providerTrackId: '0Svy0w4vj6Z8d8V7R41WqP',
    title: 'Nightcall',
    artist: 'Kavinsky',
    album: 'OutRun',
    duration: 259,
    coverUrl: 'https://i.scdn.co/image/ab67616d0000b273d6e5a0c3d3a01340b1062b88',
    externalUrl: 'https://open.spotify.com/track/0Svy0w4vj6Z8d8V7R41WqP',
    isPlayable: false
  }
];

/**
 * Checks whether dev fixtures are explicitly enabled.
 * STRICT REQUIREMENT: BOTH process.env.NODE_ENV !== 'production' AND process.env.SPOTIFY_DEV_FIXTURES === 'true'
 */
function isDevFixturesEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.SPOTIFY_DEV_FIXTURES === 'true';
}

/**
 * Search Spotify dev fixtures by query string (case-insensitive title, artist, or album).
 * @param {string} query 
 * @returns {Array<Object>|null}
 */
function searchDevFixtures(query) {
  if (!isDevFixturesEnabled()) return null;
  const q = (query || '').trim().toLowerCase();
  if (!q) return SPOTIFY_DEV_TRACKS.slice(0, 4);

  const matched = SPOTIFY_DEV_TRACKS.filter(t =>
    t.title.toLowerCase().includes(q) ||
    t.artist.toLowerCase().includes(q) ||
    (t.album && t.album.toLowerCase().includes(q))
  );

  return matched.length > 0 ? matched : [];
}

/**
 * Get a specific dev fixture track by providerTrackId.
 * Returns null if no fixture exists for that ID.
 * @param {string} providerTrackId 
 * @returns {Object|null}
 */
function getDevFixtureTrack(providerTrackId) {
  if (!isDevFixturesEnabled()) return null;
  return SPOTIFY_DEV_TRACKS.find(t => t.providerTrackId === providerTrackId) || null;
}

module.exports = {
  isDevFixturesEnabled,
  searchDevFixtures,
  getDevFixtureTrack,
  SPOTIFY_DEV_TRACKS
};
