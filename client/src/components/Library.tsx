import { useEffect, useState, useRef, useCallback, DragEvent } from 'react';
import { SERVER_URL } from '../lib/constants';
import { AddToPlaylistModal } from './AddToPlaylistModal';
import { GlassPanel } from './ui/GlassPanel';
import { Spinner } from './ui/Spinner';
import { useMusicSearch } from '../hooks/useMusicSearch';
import { useSpotifyAuth } from '../hooks/useSpotifyAuth';
import { useAuth } from '../hooks/useAuth';
import { AuthModal } from './AuthModal';
import { ProviderTrack } from '../lib/music/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface R2Track {
  id: string;
  title: string;
  artist: string | null;
  duration: number | null;
  size: number | null;
  format: string | null;
  audio_key: string;
  cover_key: string | null;
  lyrics_key: string | null;
  uploaded_at: number;
  user_id?: string | null;
}

interface StorageStats {
  used: number;
  limit: number;
  usedGB: string;
  limitGB: string;
  percentUsed: string;
  isFull: boolean;
  isGuest?: boolean;
}

interface LibraryProps {
  onSelectTrack?: (track: R2Track, signedUrl: string) => void;
  onLoadToRoom?: (track: R2Track, signedUrl: string) => void;
  onPlaySpotifyTrack?: (track: ProviderTrack) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(bytes: number | null): string {
  if (!bytes) return '0 B';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 ** 2);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function fmtDuration(secs: number | null): string {
  if (!secs) return '--:--';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function titleCase(str: string): string {
  return str.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function parseFilename(filename: string): { title: string; artist: string } {
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
  let artist = '';
  let title = nameWithoutExt;

  if (nameWithoutExt.includes(' - ')) {
    const parts = nameWithoutExt.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  } else if (nameWithoutExt.includes('_')) {
    const parts = nameWithoutExt.split('_');
    if (parts.length === 2) { artist = parts[0].trim(); title = parts[1].trim(); }
  }
  return {
    title: titleCase(title.replace(/[-_]/g, ' ').trim()),
    artist: artist ? titleCase(artist.replace(/[-_]/g, ' ').trim()) : '',
  };
}

// ─── Format Badge ─────────────────────────────────────────────────────────────

function FormatBadge({ format }: { format: string | null }) {
  const f = (format || 'mp3').toUpperCase();
  const colorMap: Record<string, string> = {
    FLAC: 'border-emerald-700/50 bg-emerald-950/20 text-emerald-400',
    WAV:  'border-blue-700/50 bg-blue-950/20 text-blue-400',
    OGG:  'border-purple-700/50 bg-purple-950/20 text-purple-400',
    MP3:  'border-accent-gold/40 bg-accent-gold/10 text-accent-gold',
    M4A:  'border-amber-700/50 bg-amber-950/20 text-amber-400',
  };
  const cls = colorMap[f] ?? 'border-noir-border bg-noir-graphite/60 text-noir-ash';
  return (
    <span className={`font-mono text-[9px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wider leading-none ${cls}`}>
      {f}
    </span>
  );
}

// ─── Shared Library Banner ───────────────────────────────────────────────────

function SharedLibraryBanner({ trackCount }: { trackCount: number }) {
  return (
    <div className="glass-panel border-b border-noir-border/50 px-4 sm:px-6 py-3 flex items-center justify-between gap-4 shrink-0">
      <div className="flex items-center gap-2.5 shrink-0">
        <span className="text-accent-gold text-base">☁</span>
        <div>
          <span className="font-ui text-xs font-semibold uppercase tracking-wider text-noir-silver">
            Cloud Library
          </span>
          <span className="hidden sm:inline text-noir-dim text-xs mx-2">·</span>
          <span className="hidden sm:inline font-ui text-xs text-noir-ash">
            Shared NoirSync cloud audio
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 font-mono text-xs text-noir-dim shrink-0">
        <span className="px-2 py-0.5 rounded bg-noir-graphite border border-noir-border/60 text-noir-ash">
          {trackCount} {trackCount === 1 ? 'track' : 'tracks'} available
        </span>
      </div>
    </div>
  );
}

// ─── Track Card ───────────────────────────────────────────────────────────────

function TrackCard({
  track, onDelete, onPlay, onAddToPlaylist, onUploadLyrics, isPlaying, isLoading, canDelete,
}: {
  track: R2Track;
  onDelete: (id: string) => void;
  onPlay: (track: R2Track) => void;
  onAddToPlaylist?: (track: R2Track) => void;
  onUploadLyrics?: (track: R2Track, file: File) => void;
  isPlaying: boolean;
  isLoading: boolean;
  canDelete?: boolean;
}) {
  const base = SERVER_URL || '';
  const coverUrl = track.cover_key ? `${base}/library/${track.id}/cover` : null;

  return (
    <GlassPanel
      className={`p-3 sm:p-3.5 rounded-xl border transition-all duration-200 flex items-center gap-3 sm:gap-3.5 group relative ${
        isPlaying
          ? 'border-accent-gold/60 bg-accent-gold/[0.04] shadow-noir-glow'
          : 'border-noir-border/50 hover:border-noir-border bg-noir-charcoal/30 hover:bg-noir-charcoal/60'
      }`}
    >
      {/* Cover */}
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-noir-graphite border border-noir-border/60 overflow-hidden shrink-0 flex items-center justify-center relative shadow-sm">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt="cover"
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <span className="text-xl opacity-35 text-accent-gold">🎵</span>
        )}
        {isPlaying && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center">
            <NowPlayingBars />
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="flex-1 min-w-0">
        <p
          className={`font-ui text-sm font-semibold truncate transition-colors ${
            isPlaying ? 'text-accent-gold' : 'text-noir-white'
          }`}
          title={track.title}
        >
          {track.title}
        </p>
        <p className="font-ui text-xs text-noir-ash truncate mt-0.5" title={track.artist || 'Unknown Artist'}>
          {track.artist || 'Unknown Artist'}
        </p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <FormatBadge format={track.format} />
          {track.lyrics_key && (
            <span className="font-mono text-[9px] px-2 py-0.5 rounded-full border border-accent-gold/40 bg-accent-gold/10 text-accent-gold flex items-center gap-0.5 font-semibold uppercase tracking-wider">
              📝 LRC
            </span>
          )}
          <span className="font-mono text-[10px] text-noir-dim">
            {fmtDuration(track.duration)}
          </span>
          <span className="font-mono text-[10px] text-noir-dim/70">
            {fmtBytes(track.size)}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={() => !isLoading && onPlay(track)}
          disabled={isLoading}
          title={isLoading ? 'Loading…' : isPlaying ? 'Pause / Active' : 'Load to Room'}
          className={`h-8 px-2.5 rounded-lg font-ui text-xs font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            isLoading ? 'opacity-50 cursor-not-allowed' : ''
          } ${
            isPlaying
              ? 'bg-accent-gold text-noir-black font-semibold shadow-sm hover:brightness-105'
              : 'btn-noir hover:border-accent-gold/50 hover:text-accent-gold'
          }`}
        >
          {isLoading ? (
            <Spinner size="sm" />
          ) : isPlaying ? (
            <>
              <span className="text-xs">⏸</span>
              <span className="hidden sm:inline">Active</span>
            </>
          ) : (
            <>
              <span className="text-xs">▶</span>
              <span className="hidden sm:inline">Play</span>
            </>
          )}
        </button>

        {onAddToPlaylist && (
          <button
            onClick={() => onAddToPlaylist(track)}
            title="Add to Playlist"
            className="btn-noir h-8 w-8 rounded-lg p-0 text-accent-gold border border-noir-border hover:border-accent-gold/40 bg-noir-graphite/40 hover:bg-accent-gold/10 flex items-center justify-center text-xs"
          >
            📋
          </button>
        )}

        {onUploadLyrics && (
          <label
            title={track.lyrics_key ? 'Replace Lyrics (.lrc)' : 'Upload Lyrics (.lrc)'}
            className={`btn-noir h-8 w-8 rounded-lg p-0 border hover:border-accent-gold/40 hover:bg-accent-gold/10 flex items-center justify-center text-xs cursor-pointer relative ${
              track.lyrics_key
                ? 'border-accent-gold/40 text-accent-gold bg-accent-gold/10'
                : 'border-noir-border text-noir-ash bg-noir-graphite/40'
            }`}
          >
            <input
              type="file"
              accept=".lrc"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUploadLyrics(track, file);
                e.target.value = '';
              }}
            />
            📝
          </label>
        )}

        {canDelete && (
          <button
            onClick={() => onDelete(track.id)}
            title="Delete track"
            className="btn-noir h-8 w-8 rounded-lg p-0 border border-red-900/40 text-red-400 hover:text-red-300 hover:bg-red-950/20 flex items-center justify-center text-xs"
          >
            🗑
          </button>
        )}
      </div>
    </GlassPanel>
  );
}

// ─── Now Playing Animated Bars ────────────────────────────────────────────────

function NowPlayingBars() {
  return (
    <div className="flex items-end gap-0.5 h-3.5">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="w-0.5 rounded-full bg-accent-gold"
          style={{
            animation: `nowplaying ${0.6 + i * 0.15}s ease-in-out infinite alternate`,
            height: `${40 + i * 20}%`,
          }}
        />
      ))}
    </div>
  );
}

// ─── Upload Form (sidebar) ────────────────────────────────────────────────────

function UploadSidebar({
  onUploaded,
  isFull,
  isGuest = false,
  onOpenAuth,
}: {
  onUploaded: () => void;
  isFull: boolean;
  isGuest?: boolean;
  onOpenAuth?: () => void;
}) {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [lyricsFile, setLyricsFile] = useState<File | null>(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [duration, setDuration] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const base = SERVER_URL || '';

  const reset = () => {
    setAudioFile(null); setCoverFile(null); setLyricsFile(null);
    setTitle(''); setArtist(''); setDuration(null);
    setProgress(0); setStatusMsg(''); setError(null);
  };

  const handleAudioSelect = (file: File) => {
    setAudioFile(file);
    const { title: pt, artist: pa } = parseFilename(file.name);
    setTitle(pt); setArtist(pa);
    const audio = new Audio();
    audio.src = URL.createObjectURL(file);
    audio.addEventListener('loadedmetadata', () => {
      setDuration(audio.duration);
      URL.revokeObjectURL(audio.src);
    });
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('audio/')) handleAudioSelect(f);
  };

  // ── Direct-to-R2 XHR PUT helper ──────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isGuest) {
      setError('Please create an account or sign in to upload tracks.');
      return;
    }
    if (!audioFile) { setError('Please select an audio file.'); return; }
    setUploading(true); setError(null); setProgress(1);

    const form = new FormData();
    form.append('audio', audioFile);
    if (coverFile)  form.append('cover', coverFile);
    if (lyricsFile) form.append('lyrics', lyricsFile);
    if (title)  form.append('title', title);
    if (artist) form.append('artist', artist);
    if (duration !== null) form.append('duration', duration.toString());

    const xhr = new XMLHttpRequest();
    xhr.timeout = 600_000; // 10 minutes (matches the server timeout)
    xhr.withCredentials = true;
    xhr.open('POST', `${base}/library/upload`);

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100));
    };

    xhr.onload = () => {
      setUploading(false);
      if (xhr.status === 403) {
        setError('Permanent account required to upload to Cloud Library.');
        return;
      }
      if (xhr.status === 507) { setError('Storage full — delete some tracks first.'); return; }
      if (xhr.status < 200 || xhr.status >= 300) {
        try { setError((JSON.parse(xhr.responseText) as { error: string }).error || 'Upload failed'); }
        catch { setError('Upload failed'); }
        return;
      }
      reset(); onUploaded();
    };
    xhr.onerror = () => { setUploading(false); setError('Network error during upload.'); };
    xhr.ontimeout = () => { setUploading(false); setError('Upload timed out. Try a smaller file or check your connection.'); };
    xhr.send(form);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Header */}
      <div className="space-y-1">
        <p className="font-ui text-xs font-semibold text-accent-gold uppercase tracking-wider flex items-center gap-1.5">
          <span>⬆</span> Upload to Cloud Library
        </p>
        <p className="font-ui text-xs text-noir-ash">
          Add tracks to the shared Cloud Library
        </p>
      </div>

      {/* Guest notice banner */}
      {isGuest && (
        <div className="p-3.5 rounded-xl border border-accent-gold/40 bg-accent-gold/5 flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-accent-gold">
            <span className="text-sm">🔒</span>
            <p className="font-ui text-xs font-semibold uppercase tracking-wider">Account Required</p>
          </div>
          <p className="font-ui text-xs text-noir-ash leading-relaxed">
            Create a free NoirSync account to upload tracks to the shared Cloud Library.
          </p>
          {onOpenAuth && (
            <button
              type="button"
              onClick={onOpenAuth}
              className="btn-noir px-3 py-1.5 rounded-lg border-accent-gold/50 text-accent-gold hover:bg-accent-gold/10 text-xs font-semibold transition-all mt-1 cursor-pointer"
            >
              Create Account / Sign In
            </button>
          )}
        </div>
      )}

      {/* Drag-and-drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => document.getElementById('lib-audio-input')?.click()}
        className={`border border-dashed rounded-xl p-5 text-center cursor-pointer transition-all duration-300 group ${
          dragOver
            ? 'border-accent-gold bg-accent-gold/10 shadow-noir-glow'
            : audioFile
            ? 'border-accent-gold/60 bg-accent-gold/[0.04]'
            : 'border-accent-gold/40 hover:border-accent-gold bg-accent-gold/[0.02] hover:bg-accent-gold/[0.06] shadow-sm hover:shadow-accent-gold/5'
        }`}
      >
        <input
          id="lib-audio-input"
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAudioSelect(f); }}
        />
        {audioFile ? (
          <div className="flex items-center gap-3 text-left">
            <div className="w-10 h-10 rounded-lg bg-accent-gold/15 text-accent-gold flex items-center justify-center text-xl shrink-0">
              🎵
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-ui text-xs font-semibold text-noir-white truncate" title={audioFile.name}>
                {audioFile.name}
              </p>
              <p className="font-mono text-[10px] text-accent-gold/80 mt-0.5">
                {fmtBytes(audioFile.size)}{duration ? ` · ${fmtDuration(duration)}` : ''}
              </p>
            </div>
          </div>
        ) : (
          <div className="py-2">
            <div className="text-2xl mb-1.5 transition-transform group-hover:scale-110 text-accent-gold">📥</div>
            <p className="font-ui text-xs text-accent-gold font-semibold uppercase tracking-wider">
              Drop audio file here
            </p>
            <p className="font-mono text-[9px] text-noir-ash mt-1">
              MP3 · WAV · FLAC · OGG · M4A · Click to browse
            </p>
          </div>
        )}
      </div>

      {/* Title & Artist */}
      <div>
        <label className="font-ui text-xs font-medium text-noir-silver mb-1.5 block">
          Track Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Track title…"
          className="w-full bg-noir-graphite border border-noir-border text-noir-white px-3.5 py-2.5 rounded-lg font-ui text-sm focus:outline-none focus:border-accent-gold/60 focus:ring-2 focus:ring-accent-gold/20 transition-all placeholder:text-noir-dim"
        />
      </div>
      <div>
        <label className="font-ui text-xs font-medium text-noir-silver mb-1.5 block">
          Artist
        </label>
        <input
          type="text"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          placeholder="Artist name…"
          className="w-full bg-noir-graphite border border-noir-border text-noir-white px-3.5 py-2.5 rounded-lg font-ui text-sm focus:outline-none focus:border-accent-gold/60 focus:ring-2 focus:ring-accent-gold/20 transition-all placeholder:text-noir-dim"
        />
      </div>

      {/* Optional files */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: 'Cover Art', accept: 'image/*', file: coverFile, setter: setCoverFile, emoji: '🖼' },
          { label: 'Lyrics .lrc', accept: '.lrc', file: lyricsFile, setter: setLyricsFile, emoji: '📝' },
        ].map(({ label, accept, file, setter, emoji }) => (
          <label key={label} className="cursor-pointer block">
            <span className="font-ui text-xs font-medium text-noir-silver mb-1.5 block">{label}</span>
            <div className={`border border-dashed rounded-lg p-2.5 text-center transition-all flex flex-col items-center justify-center gap-1 ${
              file
                ? 'border-accent-gold/50 bg-accent-gold/10 text-accent-gold'
                : 'border-noir-border hover:border-accent-gold/40 bg-noir-graphite/40 hover:bg-accent-gold/[0.03] text-noir-ash'
            }`}>
              <input
                type="file"
                accept={accept}
                className="hidden"
                onChange={(e) => setter(e.target.files?.[0] ?? null)}
              />
              <span className="text-base">{emoji}</span>
              <p className="font-ui text-xs font-medium truncate max-w-full px-1">
                {file ? file.name : 'Optional'}
              </p>
            </div>
          </label>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 rounded-lg bg-red-950/30 border border-red-900/50 text-red-400 font-ui text-xs flex justify-between items-center gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-200 transition-colors cursor-pointer text-sm shrink-0"
          >
            ✕
          </button>
        </div>
      )}

      {/* Status label shown between upload phases */}
      {uploading && statusMsg && (
        <p className="font-mono text-[10px] text-accent-gold tracking-wider text-center uppercase">
          {statusMsg}
        </p>
      )}

      {/* Upload button with integrated progress fill */}
      <div className="space-y-2">
        <button
          type="submit"
          disabled={uploading || isFull || !audioFile || isGuest}
          className={`w-full py-3 px-4 rounded-lg font-ui text-xs font-semibold uppercase tracking-wider transition-all duration-200 relative overflow-hidden flex items-center justify-center gap-2 ${
            uploading || isFull || !audioFile || isGuest
              ? 'bg-noir-graphite border border-noir-border text-noir-dim cursor-not-allowed opacity-60'
              : 'btn-noir btn-gold shadow-md hover:brightness-105 cursor-pointer'
          }`}
        >
          {uploading && (
            <div
              className="absolute left-0 top-0 bottom-0 bg-white/20 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          )}
          <span className="relative z-10 flex items-center gap-2">
            {uploading ? (
              <>
                <Spinner size="sm" />
                <span>{progress > 0 ? `Uploading… ${progress}%` : 'Starting…'}</span>
              </>
            ) : isGuest ? (
              'Permanent Account Required'
            ) : isFull ? (
              'Storage Full'
            ) : audioFile ? (
              '⬆  Upload Track'
            ) : (
              'Select Audio File First'
            )}
          </span>
        </button>

        {audioFile && !uploading && (
          <button
            type="button"
            onClick={reset}
            className="w-full text-center font-ui text-xs text-noir-dim hover:text-accent-gold transition-colors underline cursor-pointer"
          >
            Clear selection
          </button>
        )}
      </div>
    </form>
  );
}

// ─── Spotify Track Card ───────────────────────────────────────────────────────

function SpotifyTrackCard({
  track,
  onAddToPlaylist,
  onPlayInRoom,
}: {
  track: ProviderTrack;
  onAddToPlaylist: (track: ProviderTrack) => void;
  onPlayInRoom?: (track: ProviderTrack) => void;
}) {
  return (
    <GlassPanel className="p-3 sm:p-3.5 rounded-xl border border-noir-border/50 hover:border-noir-border bg-noir-charcoal/30 hover:bg-noir-charcoal/60 transition-all duration-200 flex items-center gap-3 sm:gap-3.5 group relative">
      {/* Cover */}
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-noir-graphite border border-noir-border/60 overflow-hidden shrink-0 flex items-center justify-center relative shadow-sm">
        {track.coverUrl ? (
          <img
            src={track.coverUrl}
            alt={track.title}
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <span className="text-xl opacity-35 text-accent-gold">🎵</span>
        )}
      </div>

      {/* Metadata */}
      <div className="flex-1 min-w-0">
        <p className="font-ui text-sm font-semibold text-noir-white truncate" title={track.title}>
          {track.title}
        </p>
        <p className="font-ui text-xs text-noir-ash truncate mt-0.5" title={track.artist}>
          {track.artist}
        </p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <span className="px-2 py-0.5 rounded-full text-[9px] font-mono tracking-wider font-semibold uppercase bg-[#1db954]/15 text-[#1db954] border border-[#1db954]/30">
            Spotify
          </span>
          <span className="px-2 py-0.5 rounded-full text-[9px] font-mono tracking-wider font-semibold uppercase bg-[#1db954]/10 text-[#1db954] border border-[#1db954]/20">
            Web Playback
          </span>
          {track.album && (
            <span className="font-mono text-[10px] text-noir-dim truncate max-w-[150px]" title={track.album}>
              {track.album}
            </span>
          )}
          {track.duration !== undefined && track.duration !== null && (
            <span className="font-mono text-[10px] text-noir-dim">
              {fmtDuration(track.duration)}
            </span>
          )}
        </div>
      </div>

      {/* Actions: Play in Room, Add to Playlist, Open in Spotify */}
      <div className="flex items-center gap-2 shrink-0">
        {onPlayInRoom && (
          <button
            onClick={() => onPlayInRoom(track)}
            title="Play in Room"
            className="btn-noir h-8 px-2.5 sm:px-3 rounded-lg text-xs font-ui font-medium border border-[#1db954]/40 text-[#1db954] hover:bg-[#1db954]/15 flex items-center gap-1.5 transition-all cursor-pointer"
          >
            <span>▶</span>
            <span className="hidden sm:inline">Play in Room</span>
          </button>
        )}

        <button
          onClick={() => onAddToPlaylist(track)}
          title="Add to Playlist"
          className="btn-noir h-8 px-2.5 sm:px-3 rounded-lg text-xs font-ui font-medium border border-noir-border hover:border-accent-gold/50 text-accent-gold hover:bg-accent-gold/10 flex items-center gap-1.5 transition-all cursor-pointer"
        >
          <span>📋</span>
          <span className="hidden sm:inline">Add to Playlist</span>
        </button>

        {track.externalUrl && (
          <a
            href={track.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in Spotify"
            className="btn-noir h-8 px-2.5 sm:px-3 rounded-lg text-xs font-ui font-medium border border-[#1db954]/30 text-[#1db954] hover:bg-[#1db954]/10 flex items-center gap-1.5 transition-all"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.503 17.308c-.216.354-.675.467-1.029.25-2.822-1.724-6.374-2.114-10.558-1.157-.403.093-.807-.16-.9-.562-.092-.403.16-.807.563-.9 4.582-1.047 8.513-.604 11.674 1.34.354.216.467.675.25 1.029zm1.47-3.268c-.272.443-.852.584-1.295.312-3.23-1.986-8.155-2.56-11.976-1.4-497.151-1.027-.133-1.178-.63-.151-.497.133-1.027.63-1.178 4.372-1.327 9.802-.682 13.507 1.59.443.272.585.852.312 1.295zm.126-3.411c-3.873-2.3-10.264-2.512-13.978-1.384-.593.18-1.223-.156-1.403-.75-.18-.593.156-1.223.75-1.403 4.269-1.296 11.328-1.05 15.772 1.587.534.316.71 1.008.393 1.542-.316.534-1.008.71-1.542.393z"/>
            </svg>
            <span className="hidden sm:inline">Spotify</span>
          </a>
        )}
      </div>
    </GlassPanel>
  );
}

// ─── Spotify Discovery View ───────────────────────────────────────────────────

const QUICK_SEARCH_CHIPS = [
  'The Weeknd',
  'Daft Punk',
  'Synthwave',
  'Cyberpunk 2077',
  'Kavinsky',
  'Lofi Beats',
  'Hans Zimmer',
];

function SpotifyDiscoveryView({
  onAddToPlaylist,
  onPlayInRoom,
}: {
  onAddToPlaylist: (track: ProviderTrack) => void;
  onPlayInRoom?: (track: ProviderTrack) => void;
}) {
  const { searchMusic, results, loading, error } = useMusicSearch();
  const {
    connected,
    loading: authLoading,
    providerAccountId,
    displayName,
    connect,
    disconnect,
  } = useSpotifyAuth();

  const [query, setQuery] = useState('');
  const [lastSearchedQuery, setLastSearchedQuery] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [authNotice, setAuthNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const spotifyConnected = params.get('spotify_connected');
    const spotifyError = params.get('spotify_error');

    if (spotifyConnected === 'true') {
      setAuthNotice({ type: 'success', message: 'Spotify account connected successfully!' });
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    } else if (spotifyError) {
      const errorMap: Record<string, string> = {
        invalid_state: 'Security verification failed (invalid state). Please try connecting again.',
        state_expired: 'Connection session timed out. Please try connecting again.',
        access_denied: 'Spotify connection was canceled.',
        token_exchange_failed: 'Failed to complete authorization with Spotify.',
        profile_fetch_failed: 'Failed to retrieve Spotify user profile.',
        account_already_linked: 'This Spotify account is already linked to another NoirSync user.',
        token_refresh_failed: 'Spotify authorization expired. Please reconnect your account.',
        provider_unavailable: 'Spotify service is currently unavailable.',
        spotify_premium_required:
          'Spotify requires the Developer App owner to have an active Premium subscription. Spotify may take a few hours to recognize a newly activated subscription.',
        spotify_unauthorized:
          'Spotify authorization expired or was rejected. Please connect Spotify again.',
        spotify_forbidden:
          'Spotify access was forbidden. Please verify Developer App permissions or user allowlist.',
        spotify_rate_limited:
          'Spotify is temporarily rate-limiting this app. Please try again later.',
      };
      setAuthNotice({
        type: 'error',
        message: errorMap[spotifyError] || `Spotify connection error: ${spotifyError}`,
      });
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  }, []);

  const handleSearch = (searchQuery: string) => {
    const q = searchQuery.trim();
    if (!q) return;
    setLastSearchedQuery(q);
    setHasSearched(true);
    searchMusic(q, { provider: 'spotify' });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSearch(query);
  };

  const handleChipClick = (chip: string) => {
    setQuery(chip);
    handleSearch(chip);
  };

  const spotifyResult = results.find((r) => r.provider === 'spotify');

  const isDevMode403 =
    spotifyResult?.status === 'unavailable' &&
    (spotifyResult.error?.toLowerCase().includes('development mode') ||
      spotifyResult.error?.toLowerCase().includes('premium') ||
      spotifyResult.error?.includes('403'));

  const isNotConfigured =
    spotifyResult?.status === 'unavailable' &&
    spotifyResult.error?.toLowerCase().includes('not configured');

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Account Connection Status Bar */}
      <div className="p-3.5 sm:p-4 border-b border-noir-border/30 bg-noir-surface/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-[#1db954]/10 border border-[#1db954]/30 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-[#1db954]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.503 17.308c-.216.354-.675.467-1.029.25-2.822-1.724-6.374-2.114-10.558-1.157-.403.093-.807-.16-.9-.562-.092-.403.16-.807.563-.9 4.582-1.047 8.513-.604 11.674 1.34.354.216.467.675.25 1.029zm1.47-3.268c-.272.443-.852.584-1.295.312-3.23-1.986-8.155-2.56-11.976-1.4-497.151-1.027-.133-1.178-.63-.151-.497.133-1.027.63-1.178 4.372-1.327 9.802-.682 13.507 1.59.443.272.585.852.312 1.295zm.126-3.411c-3.873-2.3-10.264-2.512-13.978-1.384-.593.18-1.223-.156-1.403-.75-.18-.593.156-1.223.75-1.403 4.269-1.296 11.328-1.05 15.772 1.587.534.316.71 1.008.393 1.542-.316.534-1.008.71-1.542.393z" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-ui text-xs font-semibold text-noir-white">
                {authLoading
                  ? 'Checking Spotify Status...'
                  : connected
                  ? 'Spotify Connected'
                  : 'Spotify Account'}
              </span>
              {connected && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase bg-[#1db954]/20 text-[#1db954] border border-[#1db954]/30 font-semibold">
                  Linked
                </span>
              )}
            </div>
            <p className="font-ui text-[11px] text-noir-dim truncate mt-0.5">
              {authLoading
                ? 'Verifying account authorization...'
                : connected
                ? `Connected as: ${displayName || providerAccountId}`
                : 'Connect your Spotify account to establish user authorization and identity.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {connected ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={authLoading}
              className="px-3 py-1.5 rounded-lg border border-noir-border/70 hover:border-red-500/40 text-noir-ash hover:text-red-400 hover:bg-red-500/5 font-ui text-xs transition-all cursor-pointer"
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              onClick={connect}
              disabled={authLoading}
              className="px-3.5 py-1.5 rounded-lg bg-[#1db954] hover:brightness-110 text-noir-black font-ui text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-all cursor-pointer"
            >
              <span>Connect Spotify</span>
            </button>
          )}
        </div>
      </div>

      {/* Auth Notification Toast / Banner */}
      {authNotice && (
        <div
          className={`px-4 py-2.5 text-xs font-ui flex items-center justify-between shrink-0 ${
            authNotice.type === 'success'
              ? 'bg-[#1db954]/10 border-b border-[#1db954]/30 text-[#1db954]'
              : 'bg-red-950/40 border-b border-red-900/50 text-red-300'
          }`}
        >
          <div className="flex items-center gap-2">
            <span>{authNotice.type === 'success' ? '✓' : '⚠'}</span>
            <span>{authNotice.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setAuthNotice(null)}
            className="text-noir-dim hover:text-noir-white transition-colors p-1"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Search Bar & Chips Header */}
      <div className="p-4 sm:p-5 border-b border-noir-border/40 bg-noir-deep/30 shrink-0 space-y-3">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-noir-dim text-sm pointer-events-none">
              🔍
            </span>
            <input
              type="text"
              placeholder="Search Spotify by track, artist, or album..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-noir-graphite border border-noir-border text-noir-white pl-10 pr-10 py-2.5 rounded-lg font-ui text-sm focus:outline-none focus:border-[#1db954]/60 focus:ring-2 focus:ring-[#1db954]/20 transition-all placeholder:text-noir-dim"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-noir-dim hover:text-noir-white transition-colors p-1"
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className={`px-4 sm:px-5 py-2.5 rounded-lg font-ui text-xs font-semibold uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer ${
              loading || !query.trim()
                ? 'bg-noir-graphite border border-noir-border text-noir-dim cursor-not-allowed opacity-60'
                : 'bg-[#1db954] text-noir-black hover:brightness-110 shadow-sm font-semibold'
            }`}
          >
            {loading ? <Spinner size="sm" /> : <span>Search</span>}
          </button>
        </form>

        {/* Quick Search Chips */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs custom-scrollbar">
          <span className="text-noir-dim font-mono text-[10px] uppercase shrink-0">
            Quick:
          </span>
          {QUICK_SEARCH_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => handleChipClick(chip)}
              className="px-2.5 py-1 rounded-full bg-noir-graphite/70 border border-noir-border/50 text-noir-ash hover:text-noir-white hover:border-[#1db954]/50 hover:bg-[#1db954]/10 transition-all text-xs shrink-0 cursor-pointer"
            >
              {chip}
            </button>
          ))}
        </div>
      </div>

      {/* Results / Feedback Area */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-5">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <Spinner size="lg" />
            <p className="font-mono text-xs text-[#1db954] tracking-widest uppercase animate-pulse">
              Searching Spotify Catalog...
            </p>
          </div>
        ) : error ? (
          <div className="p-4 rounded-xl bg-red-950/30 border border-red-900/50 text-red-400 space-y-2">
            <p className="font-ui text-sm font-semibold flex items-center gap-2">
              <span>⚠</span> Search Error
            </p>
            <p className="font-ui text-xs text-red-300">{error}</p>
          </div>
        ) : spotifyResult?.status === 'unavailable' ? (
          isDevMode403 ? (
            <GlassPanel className="p-6 rounded-2xl border border-amber-500/30 bg-amber-500/[0.04] space-y-3">
              <div className="flex items-center gap-2.5 text-amber-400">
                <span className="text-xl">⚠️</span>
                <h4 className="font-display text-base font-semibold">
                  Spotify Development Mode Restriction
                </h4>
              </div>
              <p className="font-ui text-xs text-noir-silver leading-relaxed">
                The configured Spotify application is running in Spotify Developer Mode. Under Spotify API policy, Development Mode requires the application owner to hold an active Spotify Premium subscription or whitelist user accounts in the Spotify Developer Dashboard.
              </p>
              {connected ? (
                <div className="p-3 rounded-lg bg-noir-graphite/60 border border-noir-border/50 font-ui text-xs text-noir-ash space-y-1">
                  <p className="text-[#1db954] font-semibold">
                    ✓ Spotify Account Linked: <span className="text-noir-white">{displayName || providerAccountId}</span>
                  </p>
                  <p className="text-[11px] text-noir-dim">
                    User authorization succeeded. Note that application-level catalog search is subject to Spotify Development Mode restrictions.
                  </p>
                </div>
              ) : (
                <div className="p-3 rounded-lg bg-noir-graphite/60 border border-noir-border/50 font-ui text-xs text-noir-ash space-y-1">
                  <p className="text-noir-white font-semibold">
                    Account Linking:
                  </p>
                  <p className="text-[11px] text-noir-dim">
                    You can connect your Spotify account above to establish user authorization and identity. Note that account linking establishes user authorization; it does not bypass Spotify's application-level Development Mode restrictions.
                  </p>
                </div>
              )}
              <div className="p-3 rounded-lg bg-noir-graphite/60 border border-noir-border/50 font-mono text-[11px] text-noir-ash space-y-1">
                <p className="text-accent-gold font-semibold uppercase tracking-wider">
                  Dev Tip:
                </p>
                <p>
                  To test Spotify discovery locally with verified metadata fixtures, launch the server with:
                </p>
                <p className="text-noir-white font-semibold">SPOTIFY_DEV_FIXTURES=true</p>
              </div>
            </GlassPanel>
          ) : isNotConfigured ? (
            <GlassPanel className="p-6 rounded-2xl border border-noir-border/60 bg-noir-surface/40 space-y-3">
              <div className="flex items-center gap-2.5 text-noir-gold">
                <span className="text-xl">⚙</span>
                <h4 className="font-display text-base font-semibold">
                  Spotify Credentials Not Configured
                </h4>
              </div>
              <p className="font-ui text-xs text-noir-silver leading-relaxed">
                Spotify API credentials (<code className="text-accent-gold">SPOTIFY_CLIENT_ID</code> and <code className="text-accent-gold">SPOTIFY_CLIENT_SECRET</code>) are not configured on this server.
              </p>
            </GlassPanel>
          ) : (
            <GlassPanel className="p-6 rounded-2xl border border-red-500/30 bg-red-500/[0.04] space-y-2">
              <p className="font-ui text-sm font-semibold text-red-400 flex items-center gap-2">
                <span>⚠</span> Spotify Provider Unavailable
              </p>
              <p className="font-ui text-xs text-noir-silver">
                {spotifyResult.error || 'The Spotify provider is currently unavailable.'}
              </p>
            </GlassPanel>
          )
        ) : !hasSearched ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 border border-dashed border-noir-border/60 rounded-2xl text-center max-w-lg mx-auto">
            <div className="w-14 h-14 rounded-full bg-[#1db954]/10 border border-[#1db954]/30 flex items-center justify-center text-2xl text-[#1db954]">
              🟢
            </div>
            <h3 className="font-display text-lg text-noir-white font-semibold mt-1">
              Discover Spotify Metadata
            </h3>
            <p className="font-ui text-xs text-noir-ash max-w-sm">
              Search millions of tracks on Spotify. View verified metadata, artists, and album art, and add tracks to your NoirSync playlists.
            </p>
            <div className="mt-2 px-3 py-1 rounded-full bg-[#1db954]/10 border border-[#1db954]/30 text-[10px] font-mono text-[#1db954]">
              Spotify Web Playback (stream in synced rooms)
            </div>
          </div>
        ) : spotifyResult?.results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 border border-dashed border-noir-border rounded-xl text-center">
            <p className="text-4xl opacity-20 text-[#1db954]">🔍</p>
            <p className="font-display text-lg text-noir-ash">
              No tracks found on Spotify
            </p>
            <p className="font-ui text-xs text-noir-dim max-w-sm">
              No matches found for &ldquo;{lastSearchedQuery}&rdquo;. Try checking the spelling or search for another song or artist.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-1 text-xs font-mono text-noir-dim">
              <span>
                Found {spotifyResult?.results.length} track{spotifyResult?.results.length === 1 ? '' : 's'} on Spotify
              </span>
              <span className="text-[#1db954] flex items-center gap-1">
                <span>●</span> Connected to Spotify Search
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2.5">
              {spotifyResult?.results.map((track) => (
                <SpotifyTrackCard
                  key={track.providerTrackId}
                  track={track}
                  onAddToPlaylist={onAddToPlaylist}
                  onPlayInRoom={onPlayInRoom}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Library Component ───────────────────────────────────────────────────

interface ModalTrackData {
  id?: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  duration?: number;
  provider?: string;
  provider_track_id?: string | null;
  cover_key?: string | null;
  external_url?: string | null;
}

export function Library({ onSelectTrack, onLoadToRoom, onPlaySpotifyTrack }: LibraryProps) {
  const { user, login: authLogin, register: authRegister } = useAuth();
  const isGuest = !user || user.isGuest;
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalTab, setAuthModalTab] = useState<'login' | 'register'>('register');

  const [libraryTab, setLibraryTab] = useState<'cloud' | 'spotify'>('cloud');
  const [tracks, setTracks] = useState<R2Track[]>([]);
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingTrackId, setLoadingTrackId] = useState<string | null>(null);
  const [playlistModalTrack, setPlaylistModalTrack] = useState<ModalTrackData | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const base = SERVER_URL || '';

  const handleOpenAuth = useCallback((tab: 'login' | 'register' = 'register') => {
    setAuthModalTab(tab);
    setAuthModalOpen(true);
  }, []);

  const fetchTracks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${base}/library?t=${Date.now()}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load Cloud Library');
      const data = await res.json();
      const tracksArray = Array.isArray(data) ? data : (data?.tracks ?? []);
      setTracks(tracksArray);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [base]);

  const fetchStorage = useCallback(async () => {
    try {
      const res = await fetch(`${base}/library/storage?t=${Date.now()}`, {
        credentials: 'include',
      });
      if (res.ok) setStorage(await res.json() as StorageStats);
    } catch { /* non-fatal */ }
  }, [base]);

  useEffect(() => { fetchTracks(); fetchStorage(); }, [fetchTracks, fetchStorage]);

  const handlePlay = useCallback(async (track: R2Track) => {
    try {
      const res = await fetch(`${base}/library/${track.id}/stream`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Could not get stream URL');
      const { url } = await res.json() as { url: string };

      const cb = onSelectTrack || onLoadToRoom;
      if (cb) {
        setLoadingTrackId(track.id);
        try { await cb(track, url); } finally { setLoadingTrackId(null); }
        return;
      }

      if (audioRef.current) {
        if (playingId === track.id) {
          audioRef.current.paused ? audioRef.current.play().catch(() => {}) : audioRef.current.pause();
          return;
        }
        audioRef.current.src = url; audioRef.current.load();
        audioRef.current.play().catch(() => {});
        setPlayingId(track.id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Playback error');
    }
  }, [base, onSelectTrack, onLoadToRoom, playingId]);

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm('Delete this track from your Cloud Library?')) return;
    try {
      const res = await fetch(`${base}/library/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Delete failed');
      if (playingId === id && audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; setPlayingId(null); }
      setTracks((prev) => prev.filter((t) => t.id !== id));
      fetchStorage();
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Delete error'); }
  }, [base, playingId, fetchStorage]);

  const handleUploadLyrics = useCallback(async (track: R2Track, file: File) => {
    try {
      const form = new FormData();
      form.append('lyrics', file);
      const res = await fetch(`${base}/library/${track.id}/lyrics`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to upload lyrics');
      }
      await fetchTracks();
    } catch (err: any) {
      setError(err.message || 'Failed to upload lyrics (.lrc)');
    }
  }, [base, fetchTracks]);

  const handleUploaded = useCallback(() => { fetchTracks(); fetchStorage(); }, [fetchTracks, fetchStorage]);

  const handleR2AddToPlaylist = useCallback((track: R2Track) => {
    setPlaylistModalTrack({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: 'Cloud Library',
      duration: track.duration ?? undefined,
      provider: 'local',
      cover_key: track.cover_key,
    });
  }, []);

  const handleSpotifyAddToPlaylist = useCallback((track: ProviderTrack) => {
    setPlaylistModalTrack({
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      provider: 'spotify',
      provider_track_id: track.providerTrackId,
      cover_key: track.coverUrl,
      external_url: track.externalUrl,
    });
  }, []);

  const filtered = tracks.filter((t) => {
    const q = search.toLowerCase();
    return (t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q);
  });

  return (
    <>
      <style>{`
        @keyframes nowplaying { from { height: 30%; } to { height: 90%; } }
      `}</style>

      <audio ref={audioRef} onEnded={() => setPlayingId(null)} className="hidden" />

      <div className="flex flex-col h-full bg-noir-black text-noir-white font-ui">
        {/* Mode Switcher: Cloud Tracks vs Spotify Discovery */}
        <div className="border-b border-noir-border/50 bg-noir-deep/60 px-4 sm:px-6 py-2.5 flex items-center justify-between gap-4 shrink-0">
          <div className="flex bg-noir-graphite/40 border border-noir-border/40 p-1 rounded-xl shrink-0">
            <button
              onClick={() => setLibraryTab('cloud')}
              className={`px-4 py-1.5 rounded-lg font-mono text-[11px] font-semibold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-2 ${
                libraryTab === 'cloud'
                  ? 'bg-accent-gold/15 text-accent-gold border border-accent-gold/30 shadow-sm'
                  : 'text-noir-dim hover:text-noir-white border border-transparent'
              }`}
            >
              <span>☁</span>
              <span>Cloud Library</span>
            </button>
            <button
              onClick={() => setLibraryTab('spotify')}
              className={`px-4 py-1.5 rounded-lg font-mono text-[11px] font-semibold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-2 ${
                libraryTab === 'spotify'
                  ? 'bg-[#1db954]/15 text-[#1db954] border border-[#1db954]/30 shadow-sm'
                  : 'text-noir-dim hover:text-noir-white border border-transparent'
              }`}
            >
              <span className="text-[#1db954]">🟢</span>
              <span>Spotify Discovery</span>
            </button>
          </div>
          {libraryTab === 'spotify' && (
            <span className="font-mono text-[10px] text-noir-dim uppercase tracking-wider hidden sm:inline">
              Metadata & Playlist Discovery Only
            </span>
          )}
        </div>

        {libraryTab === 'cloud' ? (
          <>
            {/* Shared Library Banner */}
            <SharedLibraryBanner trackCount={filtered.length} />

            {/* Main 2-col split */}
            <div className="flex flex-col lg:flex-row flex-1 overflow-hidden min-h-0">

              {/* ── Left: Track list ── */}
              <div className="flex-1 lg:max-w-[65%] xl:max-w-[68%] overflow-y-auto border-b lg:border-b-0 lg:border-r border-noir-border/40 flex flex-col min-h-0">
                {/* Search bar */}
                <div className="p-4 sm:p-5 border-b border-noir-border/40 shrink-0">
                  <div className="relative w-full">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-noir-dim text-sm pointer-events-none">
                      🔍
                    </span>
                    <input
                      type="text"
                      placeholder="Search tracks by title or artist…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="w-full bg-noir-graphite border border-noir-border text-noir-white pl-10 pr-10 py-2.5 rounded-lg font-ui text-sm focus:outline-none focus:border-accent-gold/60 focus:ring-2 focus:ring-accent-gold/20 transition-all placeholder:text-noir-dim"
                    />
                    {search && (
                      <button
                        onClick={() => setSearch('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-noir-dim hover:text-noir-white transition-colors p-1"
                        title="Clear search"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                {/* Error banner */}
                {error && (
                  <div className="m-4 p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-400 font-ui text-sm flex justify-between items-center shrink-0">
                    <span>{error}</span>
                    <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200 transition-colors p-1">
                      ✕
                    </button>
                  </div>
                )}

                {/* Track list body */}
                <div className="flex-1 overflow-y-auto p-4 sm:p-5">
                  {loading ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-4">
                      <Spinner size="lg" />
                      <p className="font-mono text-xs text-noir-dim tracking-widest uppercase">
                        Loading Cloud Library...
                      </p>
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-3 border border-dashed border-noir-border rounded-xl">
                      <p className="text-4xl opacity-20 text-accent-gold">☁</p>
                      <p className="font-display text-lg text-noir-ash">
                        {search ? 'No tracks found' : 'Cloud library is empty'}
                      </p>
                      <p className="font-ui text-xs text-noir-dim">
                        {search ? 'Try a different search keyword' : 'Upload a track using the form on the right →'}
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {filtered.map((track) => (
                        <TrackCard
                          key={track.id}
                          track={track}
                          onPlay={handlePlay}
                          onDelete={handleDelete}
                          onAddToPlaylist={handleR2AddToPlaylist}
                          onUploadLyrics={handleUploadLyrics}
                          isPlaying={playingId === track.id}
                          isLoading={loadingTrackId === track.id}
                          canDelete={Boolean(user?.id && track.user_id && track.user_id === user.id)}
                        />
                      ))}
                      <div className="flex items-center justify-between pt-2 text-noir-dim font-mono text-xs">
                        <span>{filtered.length} track{filtered.length !== 1 ? 's' : ''}</span>
                        <span>Shared NoirSync Cloud Storage</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── Right: Upload sidebar ── */}
              <div className="w-full lg:w-[35%] xl:w-[32%] overflow-y-auto p-4 sm:p-6 bg-noir-deep/40 flex flex-col gap-4 shrink-0">
                <UploadSidebar
                  onUploaded={handleUploaded}
                  isFull={storage?.isFull ?? false}
                  isGuest={isGuest}
                  onOpenAuth={() => handleOpenAuth('register')}
                />
              </div>
            </div>
          </>
        ) : (
          /* ── Spotify Discovery View ── */
          <SpotifyDiscoveryView
            onAddToPlaylist={handleSpotifyAddToPlaylist}
            onPlayInRoom={onPlaySpotifyTrack}
          />
        )}
      </div>

      <AddToPlaylistModal
        track={playlistModalTrack}
        isOpen={!!playlistModalTrack}
        onClose={() => setPlaylistModalTrack(null)}
      />

      <AuthModal
        isOpen={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        defaultTab={authModalTab}
        onLogin={authLogin}
        onRegister={authRegister}
      />
    </>
  );
}

