/**
 * Normalize a string by removing punctuation, extra whitespace, and making it lowercase.
 * @param {string} str 
 * @returns {string}
 */
function normalizeString(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
}

/**
 * Compare two tracks and return a confidence score that they are the same logical recording.
 * @param {import('./types').ProviderTrack} trackA 
 * @param {import('./types').ProviderTrack} trackB 
 * @returns {{ match: boolean, confidence: number }}
 */
function matchTracks(trackA, trackB) {
  if (!trackA || !trackB) return { match: false, confidence: 0 };

  const normTitleA = normalizeString(trackA.title);
  const normTitleB = normalizeString(trackB.title);
  const normArtistA = normalizeString(trackA.artist);
  const normArtistB = normalizeString(trackB.artist);

  let confidence = 0;

  // Title match
  if (normTitleA === normTitleB) {
    confidence += 0.4;
  } else if (normTitleA.includes(normTitleB) || normTitleB.includes(normTitleA)) {
    confidence += 0.2;
  }

  // Artist match
  if (normArtistA === normArtistB) {
    confidence += 0.3;
  } else if (normArtistA && normArtistB && (normArtistA.includes(normArtistB) || normArtistB.includes(normArtistA))) {
    confidence += 0.15;
  }

  // Duration match
  if (trackA.duration && trackB.duration) {
    const diff = Math.abs(trackA.duration - trackB.duration);
    if (diff <= 3) {
      confidence += 0.3;
    } else if (diff <= 10) {
      confidence += 0.15;
    } else {
      confidence -= 0.3; // Penalize if duration is significantly different
    }
  }

  return {
    match: confidence >= 0.8,
    confidence
  };
}

module.exports = {
  normalizeString,
  matchTracks
};
