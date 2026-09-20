import { useState, useEffect } from 'react';
import { useUniversalCatalog, UniversalTrack } from '../hooks/useUniversalCatalog';
import { UniversalTrackCard } from './UniversalTrackCard';
import { AddToPlaylistModal } from './AddToPlaylistModal';
import { Spinner } from './ui/Spinner';

interface UniversalMusicViewProps {
  onPlayTrack?: (track: UniversalTrack) => void;
  activeTrackId?: string | null;
}

const PROVIDERS = [
  { id: 'all', label: 'All Providers', icon: '🌐' },
  { id: 'spotify', label: 'Spotify', icon: '🟢' },
  { id: 'youtube', label: 'YouTube', icon: '▶️' },
  { id: 'apple', label: 'Apple Music', icon: '🍎' },
  { id: 'noirsync_public', label: 'NoirSync Public', icon: '☁️' },
];

export function UniversalMusicView({ onPlayTrack, activeTrackId }: UniversalMusicViewProps) {
  const {
    tracks,
    loading,
    error,
    selectedProvider,
    setSelectedProvider,
    search,
    browse,
  } = useUniversalCatalog();

  const [searchInput, setSearchInput] = useState('');
  const [modalTrack, setModalTrack] = useState<UniversalTrack | null>(null);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput.trim()) {
        search(searchInput, selectedProvider === 'all' ? undefined : selectedProvider);
      } else {
        browse(undefined, selectedProvider === 'all' ? undefined : selectedProvider);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchInput, selectedProvider, search, browse]);

  const handleProviderChange = (provId: string) => {
    setSelectedProvider(provId);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header & Search */}
      <div className="p-6 md:p-8 border-b border-noir-border/30 bg-noir-surface/40 backdrop-blur-md shrink-0 space-y-4">
        <div>
          <h1 className="font-display text-3xl text-noir-white font-bold tracking-tight">
            Universal Music
          </h1>
          <p className="font-body text-sm text-noir-ash mt-1">
            Discover and stream music across Spotify, YouTube, Apple Music, and NoirSync Public catalog.
          </p>
        </div>

        {/* Search Bar */}
        <div className="relative max-w-xl">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search tracks, artists, albums across all providers..."
            className="w-full bg-noir-graphite/60 border border-noir-border/60 rounded-xl px-4 py-2.5 pl-10 text-sm text-noir-white placeholder-noir-dim focus:outline-none focus:border-accent-gold/60 focus:ring-1 focus:ring-accent-gold/40 transition-all"
          />
          <span className="absolute left-3.5 top-3 text-noir-dim text-sm">🔍</span>
          {searchInput && (
            <button
              onClick={() => setSearchInput('')}
              className="absolute right-3 top-2.5 text-noir-dim hover:text-noir-white text-sm transition-colors"
            >
              ✕
            </button>
          )}
        </div>

        {/* Provider Filter Tabs */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
          {PROVIDERS.map((p) => {
            const isSelected = selectedProvider === p.id;
            return (
              <button
                key={p.id}
                onClick={() => handleProviderChange(p.id)}
                className={`px-3.5 py-1.5 rounded-lg font-mono text-xs font-semibold uppercase tracking-wider transition-all shrink-0 cursor-pointer flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-accent-gold/20 text-accent-gold border border-accent-gold/40 shadow-sm shadow-accent-gold/10'
                    : 'bg-noir-graphite/40 text-noir-dim hover:text-noir-ash border border-noir-border/30 hover:border-noir-border/60'
                }`}
              >
                <span>{p.icon}</span>
                <span>{p.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-6 md:p-8 space-y-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Spinner size="lg" />
            <p className="font-mono text-xs text-noir-dim uppercase tracking-wider animate-pulse">
              Querying Providers…
            </p>
          </div>
        ) : error ? (
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">
            {error}
          </div>
        ) : tracks.length === 0 ? (
          <div className="text-center py-20 border border-dashed border-noir-border/40 rounded-2xl p-8 max-w-lg mx-auto">
            <span className="text-4xl mb-3 block opacity-40">🌐</span>
            <h3 className="font-display text-lg text-noir-white font-medium">No tracks found</h3>
            <p className="font-body text-xs text-noir-ash mt-1">
              {searchInput
                ? `No matching results for "${searchInput}". Try another query or select "All Providers".`
                : 'No published tracks available in this catalog category.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5 max-w-4xl mx-auto">
            <div className="flex items-center justify-between text-xs text-noir-dim font-mono pb-1 px-1">
              <span>{tracks.length} track{tracks.length !== 1 ? 's' : ''} available</span>
              <span>Server-Authoritative Capabilities</span>
            </div>

            {tracks.map((track, idx) => (
              <UniversalTrackCard
                key={`${track.provider}-${track.providerTrackId || track.id}-${idx}`}
                track={track}
                onPlay={onPlayTrack}
                onAddToPlaylist={(t) => setModalTrack(t)}
                isPlaying={activeTrackId === track.id}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add to Playlist Modal */}
      {modalTrack && (
        <AddToPlaylistModal
          track={{
            id: modalTrack.id || undefined,
            title: modalTrack.title,
            artist: modalTrack.artist,
            album: modalTrack.album,
            duration: modalTrack.duration || undefined,
            provider: modalTrack.provider,
            provider_track_id: modalTrack.providerTrackId,
            cover_key: modalTrack.coverUrl,
            external_url: modalTrack.externalUrl,
          }}
          isOpen={Boolean(modalTrack)}
          onClose={() => setModalTrack(null)}
        />
      )}
    </div>
  );
}
