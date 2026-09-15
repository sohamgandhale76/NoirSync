import { TrackProvider } from '../../types';

export interface ProviderTrack {
  provider: TrackProvider;
  providerTrackId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  coverUrl?: string;
  externalUrl?: string;
}

export interface ProviderSearchResult {
  provider: TrackProvider;
  status: 'available' | 'unavailable' | 'error';
  error?: string;
  results: ProviderTrack[];
}

export interface MusicSearchResponse {
  query: string;
  providers: ProviderSearchResult[];
}
