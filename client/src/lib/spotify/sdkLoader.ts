// Singleton loader for Spotify Web Playback SDK
// Official script: https://sdk.scdn.co/spotify-player.js

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: any;
  }
}

let loadPromise: Promise<any> | null = null;

export function loadSpotifySDK(): Promise<any> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Window not available'));
  }

  // If Spotify is already loaded on window
  if (window.Spotify) {
    return Promise.resolve(window.Spotify);
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = new Promise((resolve, reject) => {
    const existingScript = document.getElementById('spotify-player-sdk');

    const previousOnReady = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      if (previousOnReady) previousOnReady();
      if (window.Spotify) {
        resolve(window.Spotify);
      } else {
        reject(new Error('Spotify SDK failed to initialize'));
      }
    };

    if (!existingScript) {
      const script = document.createElement('script');
      script.id = 'spotify-player-sdk';
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true;
      script.onerror = () => {
        loadPromise = null;
        reject(new Error('Failed to load Spotify Web Playback SDK script'));
      };
      document.body.appendChild(script);
    }
  });

  return loadPromise;
}
