import { useState, useEffect, useCallback } from 'react';
import { usePlaylists } from '../hooks/usePlaylists';
import { GlassPanel } from './ui/GlassPanel';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';
import { Playlist, PlaylistTrack, Track } from '../types';

interface PlaylistBrowserProps {
  isHost: boolean;
  onPlayTrack?: (track: Track) => void;
  onAddToQueue?: (track: Track) => void;
  onLoadPlaylistToRoomQueue?: (tracks: Track[]) => void;
}

function fmtDuration(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || isNaN(secs)) return '--:--';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function ProviderBadge({ provider }: { provider?: string }) {
  const p = (provider || 'local').toLowerCase();
  if (p === 'spotify') {
    return (
      <span className="px-2 py-0.5 rounded text-[10px] font-mono tracking-wider font-semibold uppercase bg-[#1db954]/10 text-[#1db954] border border-[#1db954]/30">
        Spotify
      </span>
    );
  }
  if (p === 'youtube') {
    return (
      <span className="px-2 py-0.5 rounded text-[10px] font-mono tracking-wider font-semibold uppercase bg-red-500/10 text-red-400 border border-red-500/30">
        YouTube
      </span>
    );
  }
  if (p === 'apple') {
    return (
      <span className="px-2 py-0.5 rounded text-[10px] font-mono tracking-wider font-semibold uppercase bg-pink-500/10 text-pink-400 border border-pink-500/30">
        Apple
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded text-[10px] font-mono tracking-wider font-semibold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
      Local
    </span>
  );
}

export function PlaylistBrowser({
  isHost,
  onPlayTrack,
  onAddToQueue,
  onLoadPlaylistToRoomQueue,
}: PlaylistBrowserProps) {
  const {
    playlists,
    loading: playlistsLoading,
    getPlaylist,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    removeTrackFromPlaylist,
    reorderTracks,
  } = usePlaylists();

  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [activePlaylist, setActivePlaylist] = useState<Playlist | null>(null);
  const [activeLoading, setActiveLoading] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState('');
  const [reordering, setReordering] = useState(false);

  // Auto-select first playlist if none selected
  useEffect(() => {
    if (!selectedPlaylistId && playlists.length > 0) {
      setSelectedPlaylistId(playlists[0].id);
    }
  }, [playlists, selectedPlaylistId]);

  // Load details for selected playlist
  const loadActivePlaylist = useCallback(async (id: string) => {
    setActiveLoading(true);
    try {
      const pl = await getPlaylist(id);
      setActivePlaylist(pl);
      if (pl) setEditTitleValue(pl.name);
    } catch {
      setActivePlaylist(null);
    } finally {
      setActiveLoading(false);
    }
  }, [getPlaylist]);

  useEffect(() => {
    if (selectedPlaylistId) {
      loadActivePlaylist(selectedPlaylistId);
    } else {
      setActivePlaylist(null);
    }
  }, [selectedPlaylistId, loadActivePlaylist]);

  const handleCreatePlaylist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlaylistName.trim() || isCreating) return;

    setIsCreating(true);
    try {
      const pl = await createPlaylist(newPlaylistName.trim());
      setNewPlaylistName('');
      setSelectedPlaylistId(pl.id);
    } catch {
      // Handled by hook error state
    } finally {
      setIsCreating(false);
    }
  };

  const handleSaveTitle = async () => {
    if (!activePlaylist || !editTitleValue.trim()) {
      setIsEditingTitle(false);
      return;
    }
    if (editTitleValue.trim() === activePlaylist.name) {
      setIsEditingTitle(false);
      return;
    }
    try {
      const updated = await updatePlaylist(activePlaylist.id, { name: editTitleValue.trim() });
      setActivePlaylist(updated);
    } catch {
      // ignore
    } finally {
      setIsEditingTitle(false);
    }
  };

  const handleDeletePlaylist = async () => {
    if (!activePlaylist) return;
    if (!window.confirm(`Are you sure you want to delete playlist "${activePlaylist.name}"?`)) return;

    const idToDelete = activePlaylist.id;
    try {
      await deletePlaylist(idToDelete);
      setSelectedPlaylistId(null);
      setActivePlaylist(null);
    } catch {
      // ignore
    }
  };

  const handleRemoveTrack = async (trackId: string) => {
    if (!activePlaylist) return;
    try {
      await removeTrackFromPlaylist(activePlaylist.id, trackId);
      // Refresh active playlist tracks
      await loadActivePlaylist(activePlaylist.id);
    } catch {
      // ignore
    }
  };

  const handleMoveTrack = async (index: number, direction: 'up' | 'down') => {
    if (!activePlaylist || !activePlaylist.tracks || reordering) return;
    const tracks = [...activePlaylist.tracks];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= tracks.length) return;

    const temp = tracks[index];
    tracks[index] = tracks[targetIndex];
    tracks[targetIndex] = temp;

    const newTrackIds = tracks.map((t) => t.id);
    setReordering(true);
    try {
      const updated = await reorderTracks(activePlaylist.id, newTrackIds);
      setActivePlaylist(updated);
    } catch {
      // ignore
    } finally {
      setReordering(false);
    }
  };

  const handleLoadToRoomQueue = () => {
    if (!activePlaylist || !activePlaylist.tracks || activePlaylist.tracks.length === 0) return;
    // Filter out non-playable / Spotify tracks so they never enter the active playable room queue
    const playableTracks = activePlaylist.tracks.filter(
      (t) => t.provider !== 'spotify' && t.isPlayable !== false
    );
    if (playableTracks.length === 0) return;
    if (onLoadPlaylistToRoomQueue) {
      onLoadPlaylistToRoomQueue(playableTracks);
    }
  };

  return (
    <div className="flex flex-col md:flex-row gap-4 h-full min-h-[500px]">
      {/* ── LEFT PANEL: Playlists Navigation ── */}
      <GlassPanel className="w-full md:w-72 shrink-0 p-4 flex flex-col border border-noir-border/60 bg-noir-surface/60 rounded-2xl">
        <div className="flex items-center justify-between pb-3 border-b border-noir-border/40">
          <h2 className="font-display text-sm tracking-wider uppercase font-semibold text-noir-gold">
            Playlists
          </h2>
          <span className="text-xs font-mono text-noir-ash">
            {playlists.length}
          </span>
        </div>

        {/* Create playlist input */}
        <form onSubmit={handleCreatePlaylist} className="mt-3 flex gap-2">
          <input
            type="text"
            placeholder="New playlist..."
            value={newPlaylistName}
            onChange={(e) => setNewPlaylistName(e.target.value)}
            className="w-full bg-noir-graphite/40 border border-noir-border/60 rounded-lg px-2.5 py-1.5 text-xs text-noir-white placeholder:text-noir-ash focus:outline-none focus:border-noir-gold transition-colors"
          />
          <Button
            type="submit"
            variant="gold"
            size="sm"
            disabled={!newPlaylistName.trim() || isCreating}
            loading={isCreating}
            className="shrink-0 px-2.5 py-1 text-xs"
          >
            +
          </Button>
        </form>

        {/* Playlists list */}
        <div className="mt-3 flex-1 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
          {playlistsLoading ? (
            <div className="flex items-center justify-center py-8 text-noir-ash">
              <Spinner size="sm" />
            </div>
          ) : playlists.length === 0 ? (
            <div className="py-8 text-center text-xs text-noir-ash">
              No playlists yet.
            </div>
          ) : (
            playlists.map((pl) => {
              const isSelected = selectedPlaylistId === pl.id;
              return (
                <button
                  key={pl.id}
                  onClick={() => setSelectedPlaylistId(pl.id)}
                  className={`w-full text-left p-2.5 rounded-xl border transition-all flex items-center justify-between group ${
                    isSelected
                      ? 'border-noir-gold/60 bg-noir-gold/10 text-noir-white shadow-noir-glow'
                      : 'border-noir-border/30 hover:border-noir-border/80 bg-noir-graphite/20 hover:bg-noir-graphite/50 text-noir-ash hover:text-noir-white'
                  }`}
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-xs font-medium truncate">
                      {pl.name}
                    </div>
                    <div className="text-[10px] font-mono text-noir-ash mt-0.5">
                      {pl.track_count} {pl.track_count === 1 ? 'track' : 'tracks'}
                    </div>
                  </div>
                  {isSelected && (
                    <div className="w-1.5 h-1.5 rounded-full bg-noir-gold shrink-0 animate-pulse" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </GlassPanel>

      {/* ── RIGHT PANEL: Playlist Details & Tracks ── */}
      <GlassPanel className="flex-1 p-6 flex flex-col border border-noir-border/60 bg-noir-surface/60 rounded-2xl overflow-hidden">
        {activeLoading ? (
          <div className="flex-1 flex items-center justify-center text-noir-ash">
            <Spinner size="lg" />
          </div>
        ) : !activePlaylist ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-noir-ash">
            <div className="text-3xl mb-2">📁</div>
            <h3 className="font-display text-base text-noir-white mb-1">Select a Playlist</h3>
            <p className="text-xs max-w-sm">
              Choose a playlist from the left menu or create a new one to organize your music catalog.
            </p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-noir-border/50">
              <div className="min-w-0 flex-1">
                {isEditingTitle ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={editTitleValue}
                      onChange={(e) => setEditTitleValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveTitle();
                        if (e.key === 'Escape') setIsEditingTitle(false);
                      }}
                      autoFocus
                      className="bg-noir-graphite border border-noir-gold rounded px-2 py-1 text-lg font-display text-noir-white focus:outline-none"
                    />
                    <Button variant="gold" size="sm" onClick={handleSaveTitle}>
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setIsEditingTitle(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <h1
                      onClick={() => setIsEditingTitle(true)}
                      className="font-display text-xl sm:text-2xl text-noir-white font-bold truncate hover:text-noir-gold transition-colors cursor-pointer"
                      title="Click to rename"
                    >
                      {activePlaylist.name}
                    </h1>
                    <button
                      onClick={() => setIsEditingTitle(true)}
                      className="text-noir-ash hover:text-noir-gold transition-colors p-1"
                      title="Rename playlist"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </button>
                  </div>
                )}
                {activePlaylist.description && (
                  <p className="text-xs text-noir-ash mt-1">{activePlaylist.description}</p>
                )}
                <div className="flex items-center gap-3 text-xs font-mono text-noir-ash mt-1.5">
                  <span>{activePlaylist.track_count} tracks</span>
                  <span>•</span>
                  <span>
                    Updated {new Date(activePlaylist.updated_at).toLocaleDateString()}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 shrink-0">
                {isHost && activePlaylist.tracks && activePlaylist.tracks.some((t) => t.provider !== 'spotify' && t.isPlayable !== false) && (
                  <Button
                    variant="gold"
                    size="sm"
                    onClick={handleLoadToRoomQueue}
                    className="flex items-center gap-1.5 font-medium shadow-noir-glow"
                  >
                    <span>⚡</span>
                    <span>Load to Room Queue</span>
                  </Button>
                )}
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleDeletePlaylist}
                  title="Delete playlist"
                  className="px-2.5"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </Button>
              </div>
            </div>

            {/* Tracks List */}
            <div className="flex-1 overflow-y-auto mt-4 space-y-1.5 pr-1 custom-scrollbar">
              {!activePlaylist.tracks || activePlaylist.tracks.length === 0 ? (
                <div className="py-16 text-center text-xs text-noir-ash">
                  This playlist is empty. Add songs from your Library or Provider Search!
                </div>
              ) : (
                activePlaylist.tracks.map((track: PlaylistTrack, idx: number) => (
                  <div
                    key={track.playlist_track_id || track.id}
                    className="flex items-center justify-between p-2.5 rounded-xl border border-noir-border/30 hover:border-noir-border/70 bg-noir-graphite/20 hover:bg-noir-graphite/40 transition-all group"
                  >
                    {/* Left: Position, Reorder buttons, Track info */}
                    <div className="flex items-center gap-3 min-w-0 flex-1 pr-4">
                      {/* Position & reorder */}
                      <div className="flex flex-col items-center justify-center w-6 shrink-0">
                        <span className="text-xs font-mono text-noir-ash group-hover:hidden">
                          {idx + 1}
                        </span>
                        <div className="hidden group-hover:flex flex-col items-center">
                          <button
                            onClick={() => handleMoveTrack(idx, 'up')}
                            disabled={idx === 0 || reordering}
                            className="text-[10px] text-noir-ash hover:text-noir-gold disabled:opacity-20 leading-none"
                            title="Move up"
                          >
                            ▲
                          </button>
                          <button
                            onClick={() => handleMoveTrack(idx, 'down')}
                            disabled={idx === (activePlaylist.tracks?.length ?? 0) - 1 || reordering}
                            className="text-[10px] text-noir-ash hover:text-noir-gold disabled:opacity-20 leading-none mt-0.5"
                            title="Move down"
                          >
                            ▼
                          </button>
                        </div>
                      </div>

                      {/* Track title, artist, album */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-noir-white truncate">
                            {track.title}
                          </span>
                          <ProviderBadge provider={track.provider} />
                          {track.provider === 'spotify' && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-mono tracking-wider font-semibold uppercase bg-noir-graphite/60 text-noir-ash border border-noir-border/50">
                              Metadata Only
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-noir-ash truncate mt-0.5 flex items-center gap-2">
                          <span>{track.artist || 'Unknown Artist'}</span>
                          {track.album && (
                            <>
                              <span className="opacity-40">•</span>
                              <span className="truncate opacity-75">{track.album}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Right: Duration, Play / Queue / Open in Spotify, Remove */}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs font-mono text-noir-ash pr-2">
                        {fmtDuration(track.duration)}
                      </span>

                      {track.provider === 'spotify' ? (
                        track.external_url ? (
                          <a
                            href={track.external_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-2.5 py-1 rounded-lg text-xs font-mono text-[#1db954] hover:bg-[#1db954]/10 border border-[#1db954]/30 flex items-center gap-1.5 transition-all"
                            title="Open in Spotify"
                          >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.503 17.308c-.216.354-.675.467-1.029.25-2.822-1.724-6.374-2.114-10.558-1.157-.403.093-.807-.16-.9-.562-.092-.403.16-.807.563-.9 4.582-1.047 8.513-.604 11.674 1.34.354.216.467.675.25 1.029zm1.47-3.268c-.272.443-.852.584-1.295.312-3.23-1.986-8.155-2.56-11.976-1.4-497.151-1.027-.133-1.178-.63-.151-.497.133-1.027.63-1.178 4.372-1.327 9.802-.682 13.507 1.59.443.272.585.852.312 1.295zm.126-3.411c-3.873-2.3-10.264-2.512-13.978-1.384-.593.18-1.223-.156-1.403-.75-.18-.593.156-1.223.75-1.403 4.269-1.296 11.328-1.05 15.772 1.587.534.316.71 1.008.393 1.542-.316.534-1.008.71-1.542.393z"/>
                            </svg>
                            <span>Spotify</span>
                          </a>
                        ) : null
                      ) : (
                        <>
                          {onPlayTrack && (
                            <button
                              onClick={() => onPlayTrack(track)}
                              className="p-1.5 rounded-lg text-noir-ash hover:text-noir-gold hover:bg-noir-graphite transition-all"
                              title="Play track"
                            >
                              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            </button>
                          )}

                          {onAddToQueue && (
                            <button
                              onClick={() => onAddToQueue(track)}
                              className="p-1.5 rounded-lg text-noir-ash hover:text-noir-white hover:bg-noir-graphite transition-all"
                              title="Add to queue"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                              </svg>
                            </button>
                          )}
                        </>
                      )}

                      <button
                        onClick={() => handleRemoveTrack(track.id)}
                        className="p-1.5 rounded-lg text-noir-ash hover:text-red-400 hover:bg-red-950/20 transition-all opacity-0 group-hover:opacity-100"
                        title="Remove from playlist"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
