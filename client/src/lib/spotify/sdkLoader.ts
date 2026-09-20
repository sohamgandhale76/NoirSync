// Singleton loader for Spotify Web Playback SDK
// Official script: https://sdk.scdn.co/spotify-player.js

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: any;
  }
}

let loadPromise: Promise<any> | null = null;

export function loadSpotifySDK(timeoutMs = 10000): Promise<any> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Window not available'));
  }

  // 1. If Spotify SDK object is already available on window
  if (window.Spotify) {
    return Promise.resolve(window.Spotify);
  }

  // 2. Return existing singleton in-flight promise
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = new Promise((resolve, reject) => {
    let timer: any = null;
    let pollInterval: any = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (pollInterval) clearInterval(pollInterval);
    };

    const handleSuccess = () => {
      cleanup();
      if (window.Spotify) {
        resolve(window.Spotify);
      } else {
        loadPromise = null;
        reject(new Error('Spotify SDK ready callback fired but window.Spotify is missing'));
      }
    };

    // Chain onto existing onSpotifyWebPlaybackSDKReady if present
    const previousOnReady = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      if (typeof previousOnReady === 'function') {
        try { previousOnReady(); } catch { /* ignore */ }
      }
      handleSuccess();
    };

    // Polling fallback in case onSpotifyWebPlaybackSDKReady already fired or window.Spotify appears
    pollInterval = setInterval(() => {
      if (window.Spotify) {
        handleSuccess();
      }
    }, 100);

    // Timeout guard
    timer = setTimeout(() => {
      cleanup();
      loadPromise = null;
      if (window.Spotify) {
        resolve(window.Spotify);
      } else {
        reject(new Error('Timeout loading Spotify Web Playback SDK (check network or ad-blocker)'));
      }
    }, timeoutMs);

    // Check if script tag already exists in DOM
    const existingScript = document.getElementById('spotify-player-sdk') as HTMLScriptElement | null;
    if (existingScript) {
      existingScript.addEventListener('error', () => {
        cleanup();
        loadPromise = null;
        reject(new Error('Failed to load Spotify Web Playback SDK script'));
      }, { once: true });
      return;
    }

    // Inject singleton script tag
    const script = document.createElement('script');
    script.id = 'spotify-player-sdk';
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;

    script.onerror = () => {
      cleanup();
      loadPromise = null;
      reject(new Error('Failed to load Spotify Web Playback SDK script (network or CSP blocked)'));
    };

    document.body.appendChild(script);
  });

  return loadPromise;
}
