import { useState, useCallback, useEffect } from 'react';
import { SERVER_URL } from '../lib/constants';

export interface UniversalTrackCapabilities {
  playback: 'none' | 'external_link' | 'embedded_player' | 'noirsync_stream';
  download: boolean;
  addToPlaylist: boolean;
}

export interface UniversalTrack {
  id: string | null;
  title: string;
  artist: string;
  album: string | null;
  duration: number | null;
  provider: 'spotify' | 'youtube' | 'apple' | 'noirsync_public' | string;
  providerTrackId: string;
  coverUrl: string | null;
  externalUrl: string | null;
  publicationStatus?: string;
  downloadAllowed?: boolean;
  capabilities: UniversalTrackCapabilities;
}

export function useUniversalCatalog() {
  const [tracks, setTracks] = useState<UniversalTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<string>('all');

  const search = useCallback(async (query: string, provider?: string) => {
    const trimmed = query.trim();
    setSearchQuery(trimmed);
    const prov = provider !== undefined ? provider : selectedProvider;

    if (!trimmed) {
      // If query empty, fallback to browse
      browse(undefined, prov === 'all' ? undefined : prov);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ q: trimmed });
      if (prov && prov !== 'all') {
        params.set('provider', prov);
      }

      const res = await fetch(`${SERVER_URL || ''}/api/catalog/search?${params.toString()}`, {
        credentials: 'include',
      });

      if (!res.ok) {
        throw new Error(`Failed to search catalog: ${res.statusText}`);
      }

      const data = await res.json();
      setTracks(data.tracks || []);
    } catch (err: any) {
      setError(err.message || 'Error searching universal catalog');
      setTracks([]);
    } finally {
      setLoading(false);
    }
  }, [selectedProvider]);

  const browse = useCallback(async (category?: string, provider?: string) => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (category) params.set('category', category);
      const prov = provider !== undefined ? provider : selectedProvider;
      if (prov && prov !== 'all') params.set('provider', prov);

      const res = await fetch(`${SERVER_URL || ''}/api/catalog/browse?${params.toString()}`, {
        credentials: 'include',
      });

      if (!res.ok) {
        throw new Error(`Failed to browse catalog: ${res.statusText}`);
      }

      const data = await res.json();
      setTracks(data.tracks || []);
    } catch (err: any) {
      setError(err.message || 'Error browsing universal catalog');
      setTracks([]);
    } finally {
      setLoading(false);
    }
  }, [selectedProvider]);

  const resolveTrack = useCallback(async (track: UniversalTrack): Promise<string> => {
    const res = await fetch(`${SERVER_URL || ''}/api/catalog/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        id: track.id,
        provider: track.provider,
        providerTrackId: track.providerTrackId
      })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to resolve track');
    }

    const data = await res.json();
    return data.trackId;
  }, []);

  // Initial load: browse on mount
  useEffect(() => {
    browse();
  }, [browse]);

  return {
    tracks,
    loading,
    error,
    searchQuery,
    selectedProvider,
    setSelectedProvider,
    search,
    browse,
    resolveTrack
  };
}
