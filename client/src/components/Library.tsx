import { useEffect, useState, useRef, useCallback, DragEvent } from 'react';
import { SERVER_URL } from '../lib/constants';
import { AddToPlaylistModal } from './AddToPlaylistModal';
import { GlassPanel } from './ui/GlassPanel';
import { Spinner } from './ui/Spinner';

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
}

interface StorageStats {
  used: number;
  limit: number;
  usedGB: string;
  limitGB: string;
  percentUsed: string;
  isFull: boolean;
}

interface LibraryProps {
  onSelectTrack?: (track: R2Track, signedUrl: string) => void;
  onLoadToRoom?: (track: R2Track, signedUrl: string) => void;
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

// ─── Storage Bar ──────────────────────────────────────────────────────────────

function StorageBar({ storage }: { storage: StorageStats | null }) {
  if (!storage) return null;
  const pct = Math.min(parseFloat(storage.percentUsed) || 0, 100);
  const isFull = storage.isFull;
  const isWarn = pct >= 90 && !isFull;
  const barGrad = isFull
    ? 'linear-gradient(90deg, #ef4444, #b91c1c)'
    : isWarn
    ? 'linear-gradient(90deg, #f59e0b, #d97706)'
    : 'linear-gradient(90deg, #c8a96e, #d4882a)';
  const textColor = isFull ? 'text-red-400' : isWarn ? 'text-amber-400' : 'text-accent-gold';

  return (
    <div className="glass-panel border-b border-noir-border/50 px-4 sm:px-6 py-3 flex flex-wrap sm:flex-nowrap items-center gap-3 sm:gap-4 shrink-0">
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-accent-gold text-sm">☁</span>
        <span className="font-ui text-xs font-semibold uppercase tracking-wider text-noir-silver">
          R2 Storage
        </span>
      </div>
      <div className="flex-1 min-w-[140px] h-2 bg-noir-graphite rounded-full overflow-hidden border border-noir-border/40">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{
            width: `${pct}%`,
            background: barGrad,
            boxShadow: pct > 0 ? (isFull ? '0 0 8px rgba(239,68,68,0.4)' : '0 0 8px rgba(200,169,110,0.3)') : 'none',
          }}
        />
      </div>
      <div className="flex items-center gap-2 font-mono text-xs shrink-0">
        <span className={`font-semibold ${textColor}`}>
          {storage.usedGB} <span className="text-noir-dim font-normal">/ {storage.limitGB} GB</span>
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-noir-graphite border border-noir-border/60 text-noir-ash">
          {pct.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

// ─── Track Card ───────────────────────────────────────────────────────────────

function TrackCard({
  track, onDelete, onPlay, onAddToPlaylist, onUploadLyrics, isPlaying, isLoading,
}: {
  track: R2Track;
  onDelete: (id: string) => void;
  onPlay: (track: R2Track) => void;
  onAddToPlaylist?: (track: R2Track) => void;
  onUploadLyrics?: (track: R2Track, file: File) => void;
  isPlaying: boolean;
  isLoading: boolean;
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

        <button
          onClick={() => onDelete(track.id)}
          title="Delete track"
          className="btn-noir h-8 w-8 rounded-lg p-0 border border-red-900/40 text-red-400 hover:text-red-300 hover:bg-red-950/20 flex items-center justify-center text-xs"
        >
          🗑
        </button>
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

function UploadSidebar({ onUploaded, isFull }: { onUploaded: () => void; isFull: boolean }) {
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
    xhr.open('POST', `${base}/library/upload`);

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100));
    };

    xhr.onload = () => {
      setUploading(false);
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
          <span>⬆</span> Upload to Library
        </p>
        <p className="font-ui text-xs text-noir-ash">
          Add tracks to your persistent cloud R2 storage
        </p>
      </div>

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
          disabled={uploading || isFull || !audioFile}
          className={`w-full py-3 px-4 rounded-lg font-ui text-xs font-semibold uppercase tracking-wider transition-all duration-200 relative overflow-hidden flex items-center justify-center gap-2 ${
            uploading || isFull || !audioFile
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

// ─── Main Library Component ───────────────────────────────────────────────────

export function Library({ onSelectTrack, onLoadToRoom }: LibraryProps) {
  const [tracks, setTracks] = useState<R2Track[]>([]);
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingTrackId, setLoadingTrackId] = useState<string | null>(null);
  const [playlistModalTrack, setPlaylistModalTrack] = useState<R2Track | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const base = SERVER_URL || '';

  const fetchTracks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${base}/library?t=${Date.now()}`);
      if (!res.ok) throw new Error('Failed to load R2 library');
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
      const res = await fetch(`${base}/library/storage?t=${Date.now()}`);
      if (res.ok) setStorage(await res.json() as StorageStats);
    } catch { /* non-fatal */ }
  }, [base]);

  useEffect(() => { fetchTracks(); fetchStorage(); }, [fetchTracks, fetchStorage]);

  const handlePlay = useCallback(async (track: R2Track) => {
    try {
      const res = await fetch(`${base}/library/${track.id}/stream`);
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
    if (!window.confirm('Delete this track from the R2 library?')) return;
    try {
      const res = await fetch(`${base}/library/${id}`, { method: 'DELETE' });
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
        {/* Storage Bar */}
        <StorageBar storage={storage} />

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
                      onAddToPlaylist={(t) => setPlaylistModalTrack(t)}
                      onUploadLyrics={handleUploadLyrics}
                      isPlaying={playingId === track.id}
                      isLoading={loadingTrackId === track.id}
                    />
                  ))}
                  <div className="flex items-center justify-between pt-2 text-noir-dim font-mono text-xs">
                    <span>{filtered.length} track{filtered.length !== 1 ? 's' : ''}</span>
                    {storage && <span>{storage.usedGB} GB used</span>}
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
            />
          </div>
        </div>
      </div>

      <AddToPlaylistModal
        track={playlistModalTrack ? {
          id: playlistModalTrack.id,
          title: playlistModalTrack.title,
          artist: playlistModalTrack.artist,
          album: 'Cloud Library',
          duration: playlistModalTrack.duration ?? undefined,
          provider: 'local',
          cover_key: playlistModalTrack.cover_key,
        } : null}
        isOpen={!!playlistModalTrack}
        onClose={() => setPlaylistModalTrack(null)}
      />
    </>
  );
}

