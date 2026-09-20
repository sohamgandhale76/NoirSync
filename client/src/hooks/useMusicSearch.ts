import { useState, useCallback } from 'react';
import { MusicSearchResponse, ProviderSearchResult } from '../lib/music/types';
import { TrackProvider } from '../types';
import { SERVER_URL } from '../lib/constants';

interface SearchOptions {
  provider?: TrackProvider;
}

export function useMusicSearch() {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ProviderSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const searchMusic = useCallback(async (query: string, options?: SearchOptions) => {
    if (!query) return;

    setLoading(true);
    setError(null);
    setResults([]);

    try {
      const base = SERVER_URL || '';
      const providerParam = options?.provider ? `&provider=${options.provider}` : '';
      const res = await fetch(`${base}/api/music/search?q=${encodeURIComponent(query)}${providerParam}`);
      
      if (!res.ok) {
        throw new Error(`Search failed: ${res.statusText}`);
      }

      const data: MusicSearchResponse = await res.json();
      setResults(data.providers);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error during search');
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    searchMusic,
    results,
    loading,
    error
  };
}
