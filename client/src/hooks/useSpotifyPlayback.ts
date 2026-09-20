import { useState, useEffect, useRef, useCallback } from 'react';
import { SpotifyPlaybackAdapter } from '../lib/playback/SpotifyPlaybackAdapter';
import { SERVER_URL } from '../lib/constants';

let globalSpotifyAdapter: SpotifyPlaybackAdapter | null = null;

export function getSpotifyAdapter(): SpotifyPlaybackAdapter {
  if (!globalSpotifyAdapter) {
    globalSpotifyAdapter = new SpotifyPlaybackAdapter();
  }
  return globalSpotifyAdapter;
}

export function useSpotifyPlayback() {
  const [isSpotifyConnected, setIsSpotifyConnected] = useState<boolean>(false);
  const [spotifyAccount, setSpotifyAccount] = useState<{ displayName: string; providerAccountId: string } | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTrackUri, setCurrentTrackUri] = useState<string | null>(null);

  const adapterRef = useRef<SpotifyPlaybackAdapter>(getSpotifyAdapter());

  // Check account connection status
  const checkConnection = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${SERVER_URL || ''}/api/music/accounts`, {
        credentials: 'include',
      });
      if (res.ok) {
        const accounts = await res.json();
        const spotify = accounts.find((a: any) => a.provider === 'spotify' && a.connected);
        console.info('[SpotifyPlaybackHook] /api/music/accounts response received:', {
          accountsCount: accounts.length,
          spotifyFound: Boolean(spotify),
          providerAccountId: spotify?.providerAccountId,
          displayName: spotify?.displayName,
        });
        if (spotify) {
          setIsSpotifyConnected(true);
          setSpotifyAccount({
            displayName: spotify.displayName || 'Spotify User',
            providerAccountId: spotify.providerAccountId,
          });
        } else {
          setIsSpotifyConnected(false);
          setSpotifyAccount(null);
        }
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  // Subscribe to adapter events
  useEffect(() => {
    const adapter = adapterRef.current;
    const unsubPlay = adapter.on('play', () => setIsPlaying(true));
    const unsubPause = adapter.on('pause', () => setIsPlaying(false));
    const unsubEnded = adapter.on('ended', () => setIsPlaying(false));

    return () => {
      unsubPlay();
      unsubPause();
      unsubEnded();
    };
  }, []);

  const connectSpotify = useCallback(() => {
    window.location.href = `${SERVER_URL || ''}/api/music/connect/spotify`;
  }, []);

  const playSpotifyTrack = useCallback(async (trackIdOrUri: string) => {
    try {
      setError(null);
      const adapter = adapterRef.current;
      adapter.setSrc(trackIdOrUri);
      setCurrentTrackUri(adapter.getSrc());
      await adapter.play();
    } catch (err: any) {
      setError(err.message || 'Spotify playback failed');
      setIsPlaying(false);
      throw err;
    }
  }, []);

  const pauseSpotify = useCallback(() => {
    adapterRef.current.pause();
  }, []);

  return {
    isSpotifyConnected,
    spotifyAccount,
    loading,
    error,
    isPlaying,
    currentTrackUri,
    adapter: adapterRef.current,
    connectSpotify,
    playSpotifyTrack,
    pauseSpotify,
    refreshConnection: checkConnection
  };
}
