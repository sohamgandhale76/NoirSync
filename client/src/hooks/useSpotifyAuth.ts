import { useState, useEffect, useCallback } from 'react';
import { SERVER_URL } from '../lib/constants';

export interface ConnectedAccount {
  provider: string;
  connected: boolean;
  providerAccountId: string;
  displayName?: string;
}

export function useSpotifyAuth() {
  const [connected, setConnected] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [providerAccountId, setProviderAccountId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const base = SERVER_URL || '';
      const res = await fetch(`${base}/api/music/accounts`, {
        credentials: 'include',
      });
      if (res.status === 401) {
        setConnected(false);
        setProviderAccountId(null);
        setDisplayName(null);
        return;
      }
      if (!res.ok) {
        throw new Error(`Failed to fetch connected accounts (${res.status})`);
      }
      const accounts: ConnectedAccount[] = await res.json();
      const spotifyAccount = accounts.find((a) => a.provider === 'spotify');
      if (spotifyAccount && spotifyAccount.connected) {
        setConnected(true);
        setProviderAccountId(spotifyAccount.providerAccountId);
        setDisplayName(spotifyAccount.displayName || spotifyAccount.providerAccountId);
      } else {
        setConnected(false);
        setProviderAccountId(null);
        setDisplayName(null);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to check Spotify account status');
      setConnected(false);
      setProviderAccountId(null);
      setDisplayName(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const connect = useCallback(() => {
    const base = SERVER_URL || '';
    window.location.href = `${base}/api/music/connect/spotify`;
  }, []);

  const disconnect = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const base = SERVER_URL || '';
      const res = await fetch(`${base}/api/music/disconnect/spotify`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error(`Failed to disconnect Spotify (${res.status})`);
      }
      setConnected(false);
      setProviderAccountId(null);
      setDisplayName(null);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to disconnect Spotify';
      setError(msg);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  return {
    connected,
    loading,
    providerAccountId,
    displayName,
    error,
    checkStatus,
    connect,
    disconnect,
  };
}
