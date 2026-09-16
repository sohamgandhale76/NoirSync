import { useState } from 'react';
import { usePlaylists } from '../hooks/usePlaylists';
import { GlassPanel } from './ui/GlassPanel';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';
import { Playlist } from '../types';

interface AddToPlaylistModalProps {
  track: {
    id?: string;
    title: string;
    artist?: string | null;
    album?: string | null;
    duration?: number;
    provider?: string;
    provider_track_id?: string | null;
    cover_key?: string | null;
    external_url?: string | null;
  } | null;
  isOpen: boolean;
  onClose: () => void;
  onAdded?: (playlist: Playlist) => void;
}

export function AddToPlaylistModal({
  track,
  isOpen,
  onClose,
  onAdded,
}: AddToPlaylistModalProps) {
  const { playlists, loading, createPlaylist, addTrackToPlaylist } = usePlaylists();
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [addingToId, setAddingToId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  if (!isOpen || !track) return null;

  const handleAddToPlaylist = async (playlist: Playlist) => {
    setAddingToId(playlist.id);
    setFeedback(null);
    try {
      await addTrackToPlaylist(playlist.id, track.id, {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        provider: track.provider || 'local',
        provider_track_id: track.provider_track_id,
        cover_key: track.cover_key,
        external_url: track.external_url,
      });

      setFeedback({ type: 'success', message: `Added to "${playlist.name}"` });
      if (onAdded) onAdded(playlist);
      setTimeout(() => {
        onClose();
        setFeedback(null);
      }, 1000);
    } catch (err: any) {
      const msg = err.message || 'Failed to add to playlist';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setAddingToId(null);
    }
  };

  const handleCreateAndAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlaylistName.trim()) return;

    setIsCreating(true);
    setFeedback(null);
    try {
      const newPl = await createPlaylist(newPlaylistName.trim());
      setNewPlaylistName('');
      await handleAddToPlaylist(newPl);
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Failed to create playlist' });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fadeIn">
      <GlassPanel glow className="w-full max-w-md p-6 relative border border-noir-border/80 bg-noir-surface/90 shadow-2xl rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-noir-border/50">
          <div>
            <h3 className="font-display text-lg text-noir-white font-semibold">Add to Playlist</h3>
            <p className="text-xs text-noir-ash truncate max-w-[280px] mt-0.5">
              {track.title} {track.artist ? `— ${track.artist}` : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-noir-ash hover:text-noir-white transition-colors p-1 rounded-lg hover:bg-noir-graphite"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Feedback alert */}
        {feedback && (
          <div
            className={`mt-3 p-3 rounded-lg text-xs font-mono flex items-center gap-2 ${
              feedback.type === 'success'
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}
          >
            {feedback.type === 'success' ? '✓' : '⚠'} {feedback.message}
          </div>
        )}

        {/* Quick create new playlist form */}
        <form onSubmit={handleCreateAndAdd} className="mt-4 flex gap-2">
          <input
            type="text"
            placeholder="New playlist name..."
            value={newPlaylistName}
            onChange={(e) => setNewPlaylistName(e.target.value)}
            className="flex-1 bg-noir-graphite/60 border border-noir-border/80 rounded-lg px-3 py-2 text-sm text-noir-white placeholder:text-noir-ash focus:outline-none focus:border-noir-gold transition-colors"
          />
          <Button
            type="submit"
            variant="gold"
            size="sm"
            disabled={!newPlaylistName.trim() || isCreating}
            loading={isCreating}
          >
            Create & Add
          </Button>
        </form>

        {/* Playlists list */}
        <div className="mt-4 max-h-64 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-noir-ash">
              <Spinner size="md" />
            </div>
          ) : playlists.length === 0 ? (
            <div className="py-8 text-center text-xs text-noir-ash">
              No playlists found. Create one above!
            </div>
          ) : (
            playlists.map((pl) => (
              <button
                key={pl.id}
                onClick={() => handleAddToPlaylist(pl)}
                disabled={addingToId === pl.id}
                className="w-full text-left p-3 rounded-xl border border-noir-border/40 hover:border-noir-gold/50 bg-noir-graphite/30 hover:bg-noir-graphite/70 transition-all flex items-center justify-between group"
              >
                <div className="min-w-0 pr-3">
                  <div className="text-sm font-medium text-noir-white group-hover:text-noir-gold transition-colors truncate">
                    {pl.name}
                  </div>
                  <div className="text-xs text-noir-ash mt-0.5">
                    {pl.track_count} {pl.track_count === 1 ? 'track' : 'tracks'}
                  </div>
                </div>
                <div className="shrink-0">
                  {addingToId === pl.id ? (
                    <Spinner size="sm" />
                  ) : (
                    <span className="text-xs font-mono text-noir-ash group-hover:text-noir-gold transition-colors">
                      + Add
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </GlassPanel>
    </div>
  );
}
