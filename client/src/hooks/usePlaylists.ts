import { useState, useCallback, useEffect } from 'react';
import { Playlist } from '../types';
import { SERVER_URL } from '../lib/constants';

export function usePlaylists() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPlaylists = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/playlists`, {
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch playlists (status: ${res.status})`);
      }
      const data = await res.json();
      setPlaylists(data.playlists || []);
      return data.playlists || [];
    } catch (err: any) {
      const msg = err.message || 'Failed to fetch playlists';
      setError(msg);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const getPlaylist = useCallback(async (playlistId: string): Promise<Playlist | null> => {
    try {
      const res = await fetch(`${SERVER_URL}/api/playlists/${encodeURIComponent(playlistId)}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`Failed to load playlist (status: ${res.status})`);
      }
      const data = await res.json();
      return data.playlist;
    } catch (err: any) {
      setError(err.message || 'Failed to load playlist');
      throw err;
    }
  }, []);

  const createPlaylist = useCallback(async (name: string, description?: string): Promise<Playlist> => {
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/playlists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, description }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create playlist');
      }
      setPlaylists((prev) => [data.playlist, ...prev]);
      return data.playlist;
    } catch (err: any) {
      setError(err.message || 'Failed to create playlist');
      throw err;
    }
  }, []);

  const updatePlaylist = useCallback(async (
    playlistId: string,
    updates: { name?: string; description?: string }
  ): Promise<Playlist> => {
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/playlists/${encodeURIComponent(playlistId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update playlist');
      }
      setPlaylists((prev) =>
        prev.map((p) => (p.id === playlistId ? { ...p, ...data.playlist } : p))
      );
      return data.playlist;
    } catch (err: any) {
      setError(err.message || 'Failed to update playlist');
      throw err;
    }
  }, []);

  const renamePlaylist = useCallback(async (playlistId: string, name: string): Promise<Playlist> => {
    return updatePlaylist(playlistId, { name });
  }, [updatePlaylist]);

  const deletePlaylist = useCallback(async (playlistId: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/playlists/${encodeURIComponent(playlistId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete playlist');
      }
      setPlaylists((prev) => prev.filter((p) => p.id !== playlistId));
      return true;
    } catch (err: any) {
      setError(err.message || 'Failed to delete playlist');
      throw err;
    }
  }, []);

  const addTrackToPlaylist = useCallback(async (
    playlistId: string,
    trackId?: string,
    trackData?: any
  ) => {
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ trackId, trackData }),
      });
      const data = await res.json();
      if (!res.ok) {
        const error = new Error(data.error || 'Failed to add track to playlist');
        (error as any).status = res.status;
        throw error;
      }
      // Increment track_count locally
      setPlaylists((prev) =>
        prev.map((p) =>
          p.id === playlistId ? { ...p, track_count: (p.track_count || 0) + 1, updated_at: Date.now() } : p
        )
      );
      return data.item;
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, []);

  const removeTrackFromPlaylist = useCallback(async (playlistId: string, trackId: string) => {
    setError(null);
    try {
      const res = await fetch(
        `${SERVER_URL}/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`,
        {
          method: 'DELETE',
          credentials: 'include',
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to remove track from playlist');
      }
      // Decrement track_count locally
      setPlaylists((prev) =>
        prev.map((p) =>
          p.id === playlistId ? { ...p, track_count: Math.max(0, (p.track_count || 1) - 1), updated_at: Date.now() } : p
        )
      );
      return true;
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, []);

  const reorderTracks = useCallback(async (playlistId: string, trackIds: string[]): Promise<Playlist> => {
    setError(null);
    try {
      const res = await fetch(
        `${SERVER_URL}/api/playlists/${encodeURIComponent(playlistId)}/tracks/reorder`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ trackIds }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reorder playlist tracks');
      }
      setPlaylists((prev) =>
        prev.map((p) => (p.id === playlistId ? { ...p, ...data.playlist } : p))
      );
      return data.playlist;
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, []);

  useEffect(() => {
    fetchPlaylists();
  }, [fetchPlaylists]);

  return {
    playlists,
    loading,
    error,
    fetchPlaylists,
    getPlaylist,
    createPlaylist,
    updatePlaylist,
    renamePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    reorderTracks,
  };
}
