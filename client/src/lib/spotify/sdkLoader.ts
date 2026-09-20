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
  console.info('[SpotifySDKLoader] loadSpotifySDK called. window.Spotify exists:', Boolean(window?.Spotify), 'loadPromise exists:', Boolean(loadPromise));

  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Window not available'));
  }

  // 1. If Spotify SDK object is already available on window
  if (window.Spotify) {
    console.info('[SpotifySDKLoader] window.Spotify already detected immediately on entry.');
    return Promise.resolve(window.Spotify);
  }

  // 2. Return existing singleton in-flight promise
  if (loadPromise) {
    console.info('[SpotifySDKLoader] Returning existing in-flight loadPromise singleton.');
    return loadPromise;
  }

  loadPromise = new Promise((resolve, reject) => {
    let timer: any = null;
    let pollInterval: any = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (pollInterval) clearInterval(pollInterval);
    };

    const handleSuccess = (source: string) => {
      cleanup();
      console.info(`[SpotifySDKLoader] handleSuccess triggered via [${source}]. window.Spotify present:`, Boolean(window.Spotify));
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
      console.info('[SpotifySDKLoader] window.onSpotifyWebPlaybackSDKReady callback invoked by SDK script.');
      if (typeof previousOnReady === 'function') {
        try { previousOnReady(); } catch (err) { console.warn('[SpotifySDKLoader] previousOnReady error:', err); }
      }
      handleSuccess('onSpotifyWebPlaybackSDKReady');
    };

    // Polling fallback in case onSpotifyWebPlaybackSDKReady already fired or window.Spotify appears
    pollInterval = setInterval(() => {
      if (window.Spotify) {
        console.info('[SpotifySDKLoader] Polling interval detected window.Spotify.');
        handleSuccess('pollInterval');
      }
    }, 100);

    // Timeout guard
    timer = setTimeout(() => {
      cleanup();
      console.warn('[SpotifySDKLoader] Timeout reached waiting for Spotify Web Playback SDK.');
      loadPromise = null;
      if (window.Spotify) {
        console.info('[SpotifySDKLoader] window.Spotify found at timeout.');
        resolve(window.Spotify);
      } else {
        reject(new Error('Timeout loading Spotify Web Playback SDK (check network or ad-blocker)'));
      }
    }, timeoutMs);

    // Check if script tag already exists in DOM
    const existingScript = document.getElementById('spotify-player-sdk') as HTMLScriptElement | null;
    if (existingScript) {
      if (window.Spotify) {
        console.info('[SpotifySDKLoader] Existing script tag detected and window.Spotify is present. Resolving immediately.');
        cleanup();
        resolve(window.Spotify);
        return;
      }
      console.warn('[SpotifySDKLoader] Stale or non-ready script tag detected in DOM without active loader. Removing stale element to force fresh load.');
      if (existingScript.parentNode) {
        existingScript.parentNode.removeChild(existingScript);
      } else {
        existingScript.remove();
      }
    }

    // Inject singleton script tag
    const script = document.createElement('script');
    script.id = 'spotify-player-sdk';
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;

    script.onload = () => {
      console.info('[SpotifySDKLoader] Script tag fired onload event. Waiting for onSpotifyWebPlaybackSDKReady or window.Spotify.');
    };

    script.onerror = (err) => {
      cleanup();
      loadPromise = null;
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      } else {
        script.remove();
      }
      console.error('[SpotifySDKLoader] Script tag fired onerror event. Network or CSP blocked.', err);
      reject(new Error('Failed to load Spotify Web Playback SDK script (network or CSP blocked)'));
    };

    console.info('[SpotifySDKLoader] Inserting <script> element into document.body with src:', script.src);
    document.body.appendChild(script);
  });

  return loadPromise;
}
