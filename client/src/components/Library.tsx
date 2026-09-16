import { useEffect, useState, useRef, useCallback, DragEvent } from 'react';
import { SERVER_URL } from '../lib/constants';
import { AddToPlaylistModal } from './AddToPlaylistModal';

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
  const map: Record<string, { bg: string; text: string; border: string }> = {
    FLAC: { bg: 'rgba(16,185,129,0.08)', text: '#34d399', border: 'rgba(16,185,129,0.3)' },
    WAV:  { bg: 'rgba(59,130,246,0.08)',  text: '#60a5fa', border: 'rgba(59,130,246,0.3)' },
    OGG:  { bg: 'rgba(168,85,247,0.08)', text: '#c084fc', border: 'rgba(168,85,247,0.3)' },
    MP3:  { bg: 'rgba(200,169,110,0.08)', text: '#c8a96e', border: 'rgba(200,169,110,0.3)' },
    M4A:  { bg: 'rgba(251,146,60,0.08)', text: '#fb923c', border: 'rgba(251,146,60,0.3)' },
  };
  const c = map[f] ?? { bg: 'rgba(255,255,255,0.04)', text: '#888', border: 'rgba(255,255,255,0.1)' };
  return (
    <span style={{
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
      fontFamily: 'monospace', fontSize: '9px', padding: '2px 6px',
      borderRadius: '4px', letterSpacing: '0.12em', textTransform: 'uppercase',
      fontWeight: 600, lineHeight: 1,
    }}>
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
    ? 'linear-gradient(90deg,#ef4444,#b91c1c)'
    : isWarn
    ? 'linear-gradient(90deg,#f59e0b,#d97706)'
    : 'linear-gradient(90deg,#c8a96e,#d4882a)';
  const textColor = isFull ? '#f87171' : isWarn ? '#fbbf24' : '#c8a96e';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '12px',
      padding: '10px 18px',
      background: 'rgba(255,255,255,0.02)',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
    }}>
      <span style={{ fontFamily: 'monospace', fontSize: '9px', color: '#555', letterSpacing: '0.15em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
        R2 Storage
      </span>
      <div style={{ flex: 1, height: '3px', borderRadius: '2px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: '2px', background: barGrad, transition: 'width 0.7s ease' }} />
      </div>
      <span style={{ fontFamily: 'monospace', fontSize: '10px', color: textColor, whiteSpace: 'nowrap', fontWeight: 600 }}>
        {storage.usedGB} <span style={{ color: '#444', fontWeight: 400 }}>/ {storage.limitGB} GB</span>
      </span>
    </div>
  );
}

// ─── Track Card ───────────────────────────────────────────────────────────────

function TrackCard({
  track, onDelete, onPlay, onAddToPlaylist, isPlaying, isLoading,
}: {
  track: R2Track;
  onDelete: (id: string) => void;
  onPlay: (track: R2Track) => void;
  onAddToPlaylist?: (track: R2Track) => void;
  isPlaying: boolean;
  isLoading: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const base = SERVER_URL || '';
  const coverUrl = track.cover_key ? `${base}/library/${track.id}/cover` : null;
  const active = isPlaying || hovered;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '10px 14px',
        borderRadius: '10px',
        border: isPlaying
          ? '1px solid rgba(200,169,110,0.4)'
          : `1px solid ${hovered ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)'}`,
        background: isPlaying
          ? 'rgba(200,169,110,0.05)'
          : hovered ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.01)',
        transition: 'all 0.2s ease',
        cursor: 'default',
        boxShadow: isPlaying ? '0 0 20px rgba(200,169,110,0.08)' : 'none',
      }}
    >
      {/* Cover */}
      <div style={{
        width: '44px', height: '44px', borderRadius: '7px', flexShrink: 0,
        background: 'rgba(255,255,255,0.04)', overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative',
      }}>
        {coverUrl ? (
          <img src={coverUrl} alt="cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <span style={{ fontSize: '18px', opacity: 0.15 }}>♪</span>
        )}
        {isPlaying && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(200,169,110,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <NowPlayingBars />
          </div>
        )}
      </div>

      {/* Metadata */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontFamily: 'monospace', fontSize: '12px', color: '#e8e8e8',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          marginBottom: '3px', fontWeight: isPlaying ? 600 : 400,
        }} title={track.title}>{track.title}</p>
        <p style={{
          fontFamily: 'monospace', fontSize: '10px', color: '#555',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          marginBottom: '5px',
        }}>{track.artist || 'Unknown Artist'}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <FormatBadge format={track.format} />
          {track.lyrics_key && (
            <span style={{
              fontFamily: 'monospace', fontSize: '9px', padding: '2px 5px',
              border: '1px solid rgba(200,169,110,0.25)', borderRadius: '4px',
              color: '#c8a96e', background: 'rgba(200,169,110,0.06)',
              letterSpacing: '0.1em', textTransform: 'uppercase',
            }}>LRC</span>
          )}
          <span style={{ fontFamily: 'monospace', fontSize: '9px', color: '#444' }}>
            {fmtDuration(track.duration)}
          </span>
          <span style={{ fontFamily: 'monospace', fontSize: '9px', color: '#333' }}>
            {fmtBytes(track.size)}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '6px', opacity: active ? 1 : 0, transition: 'opacity 0.2s' }}>
        <button
          onClick={() => !isLoading && onPlay(track)}
          disabled={isLoading}
          title={isLoading ? 'Loading…' : isPlaying ? 'Playing' : 'Load to Room'}
          style={{
            width: '32px', height: '32px', borderRadius: '8px',
            border: isPlaying ? '1px solid rgba(200,169,110,0.5)' : '1px solid rgba(255,255,255,0.1)',
            background: isPlaying ? 'rgba(200,169,110,0.15)' : 'rgba(255,255,255,0.04)',
            color: isPlaying ? '#c8a96e' : '#aaa',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s', fontSize: '13px',
          }}
          onMouseEnter={(e) => { if (!isLoading && !isPlaying) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(200,169,110,0.4)'; (e.currentTarget as HTMLButtonElement).style.color = '#c8a96e'; } }}
          onMouseLeave={(e) => { if (!isLoading && !isPlaying) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.1)'; (e.currentTarget as HTMLButtonElement).style.color = '#aaa'; } }}
        >
          {isLoading ? (
            <div style={{ width: '12px', height: '12px', border: '2px solid #c8a96e', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          ) : isPlaying ? '⏸' : '▶'}
        </button>
        {onAddToPlaylist && (
          <button
            onClick={() => onAddToPlaylist(track)}
            title="Add to Playlist"
            style={{
              width: '32px', height: '32px', borderRadius: '8px',
              border: '1px solid rgba(200,169,110,0.25)', background: 'rgba(200,169,110,0.06)',
              color: '#c8a96e', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', transition: 'all 0.2s', fontSize: '13px',
            }}
            onMouseEnter={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.borderColor = 'rgba(200,169,110,0.6)'; b.style.background = 'rgba(200,169,110,0.18)'; }}
            onMouseLeave={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.borderColor = 'rgba(200,169,110,0.25)'; b.style.background = 'rgba(200,169,110,0.06)'; }}
          >
            📋
          </button>
        )}
        <button
          onClick={() => onDelete(track.id)}
          title="Delete"
          style={{
            width: '32px', height: '32px', borderRadius: '8px',
            border: '1px solid rgba(255,60,60,0.15)', background: 'rgba(255,60,60,0.03)',
            color: 'rgba(248,113,113,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', transition: 'all 0.2s', fontSize: '12px',
          }}
          onMouseEnter={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.borderColor = 'rgba(248,113,113,0.4)'; b.style.color = '#f87171'; b.style.background = 'rgba(248,113,113,0.06)'; }}
          onMouseLeave={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.borderColor = 'rgba(255,60,60,0.15)'; b.style.color = 'rgba(248,113,113,0.5)'; b.style.background = 'rgba(255,60,60,0.03)'; }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── Now Playing Animated Bars ────────────────────────────────────────────────

function NowPlayingBars() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '14px' }}>
      {[1, 2, 3].map((i) => (
        <div key={i} style={{
          width: '3px', borderRadius: '1px', background: '#c8a96e',
          animation: `nowplaying ${0.6 + i * 0.15}s ease-in-out infinite alternate`,
          height: `${40 + i * 20}%`,
        }} />
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

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    color: '#e0e0e0', padding: '8px 10px',
    borderRadius: '7px', fontFamily: 'monospace', fontSize: '11px',
    outline: 'none', transition: 'border-color 0.2s',
  };

  const labelStyle: React.CSSProperties = {
    fontFamily: 'monospace', fontSize: '9px', color: '#444',
    letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '5px', display: 'block',
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

      {/* Drag-and-drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => document.getElementById('lib-audio-input')?.click()}
        style={{
          position: 'relative', cursor: 'pointer',
          border: `1px dashed ${audioFile ? 'rgba(200,169,110,0.5)' : dragOver ? 'rgba(200,169,110,0.7)' : 'rgba(255,255,255,0.1)'}`,
          borderRadius: '10px', padding: '20px 12px', textAlign: 'center',
          background: audioFile
            ? 'rgba(200,169,110,0.04)'
            : dragOver ? 'rgba(200,169,110,0.06)' : 'rgba(255,255,255,0.01)',
          transition: 'all 0.2s',
          boxShadow: dragOver ? '0 0 20px rgba(200,169,110,0.1)' : 'none',
        }}
      >
        <input
          id="lib-audio-input"
          type="file"
          accept="audio/*"
          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', pointerEvents: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAudioSelect(f); }}
        />
        {audioFile ? (
          <>
            <div style={{ fontSize: '22px', marginBottom: '6px' }}>🎵</div>
            <p style={{ fontFamily: 'monospace', fontSize: '11px', color: '#c8a96e', marginBottom: '2px' }}>
              {audioFile.name.length > 28 ? audioFile.name.slice(0, 28) + '…' : audioFile.name}
            </p>
            <p style={{ fontFamily: 'monospace', fontSize: '9px', color: '#555' }}>
              {fmtBytes(audioFile.size)}{duration ? ` · ${fmtDuration(duration)}` : ''}
            </p>
          </>
        ) : (
          <>
            <div style={{ fontSize: '28px', marginBottom: '8px', opacity: 0.3 }}>⬆</div>
            <p style={{ fontFamily: 'monospace', fontSize: '11px', color: '#555', marginBottom: '3px' }}>
              Drop audio here
            </p>
            <p style={{ fontFamily: 'monospace', fontSize: '9px', color: '#333', letterSpacing: '0.1em' }}>
              MP3 · WAV · FLAC · OGG
            </p>
          </>
        )}
      </div>

      {/* Title & Artist */}
      <div>
        <span style={labelStyle}>Title</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="Track title…" style={inputStyle}
          onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = 'rgba(200,169,110,0.4)'; }}
          onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.08)'; }}
        />
      </div>
      <div>
        <span style={labelStyle}>Artist</span>
        <input type="text" value={artist} onChange={(e) => setArtist(e.target.value)}
          placeholder="Artist name…" style={inputStyle}
          onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = 'rgba(200,169,110,0.4)'; }}
          onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.08)'; }}
        />
      </div>

      {/* Optional files */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        {[
          { label: 'Cover Art', accept: 'image/*', file: coverFile, setter: setCoverFile, emoji: '🖼' },
          { label: 'Lyrics .lrc', accept: '.lrc', file: lyricsFile, setter: setLyricsFile, emoji: '📝' },
        ].map(({ label, accept, file, setter, emoji }) => (
          <label key={label} style={{ cursor: 'pointer' }}>
            <span style={labelStyle}>{label}</span>
            <div style={{
              position: 'relative', border: `1px dashed ${file ? 'rgba(200,169,110,0.35)' : 'rgba(255,255,255,0.06)'}`,
              borderRadius: '7px', padding: '8px 6px', textAlign: 'center',
              background: file ? 'rgba(200,169,110,0.03)' : 'transparent', transition: 'all 0.2s',
            }}>
              <input type="file" accept={accept} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                onChange={(e) => setter(e.target.files?.[0] ?? null)} />
              <p style={{ fontFamily: 'monospace', fontSize: '9px', color: file ? '#c8a96e' : '#333' }}>
                {file ? file.name.slice(0, 14) + (file.name.length > 14 ? '…' : '') : `${emoji} optional`}
              </p>
            </div>
          </label>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '8px 10px', borderRadius: '7px',
          background: 'rgba(248,113,113,0.05)',
          border: '1px solid rgba(248,113,113,0.2)',
          fontFamily: 'monospace', fontSize: '10px', color: '#f87171',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', opacity: 0.6, fontSize: '12px' }}>✕</button>
        </div>
      )}

      {/* Status label shown between upload phases */}
      {uploading && statusMsg && (
        <p style={{ fontFamily: 'monospace', fontSize: '9px', color: '#555', letterSpacing: '0.1em', textAlign: 'center', margin: '-6px 0' }}>
          {statusMsg}
        </p>
      )}

      {/* Upload button with integrated progress fill */}
      <button
        type="submit"
        disabled={uploading || isFull || !audioFile}
        style={{
          position: 'relative', overflow: 'hidden',
          width: '100%', padding: '11px 16px',
          borderRadius: '8px', border: 'none', cursor: 'pointer',
          fontFamily: 'monospace', fontSize: '11px', fontWeight: 700,
          letterSpacing: '0.15em', textTransform: 'uppercase',
          color: uploading || isFull || !audioFile ? 'rgba(10,10,15,0.5)' : '#0a0a0f',
          background: uploading || isFull || !audioFile
            ? 'rgba(200,169,110,0.25)'
            : 'linear-gradient(135deg,#c8a96e,#d4882a)',
          transition: 'all 0.2s',
          boxShadow: uploading || isFull || !audioFile
            ? 'none'
            : '0 4px 20px rgba(200,169,110,0.25)',
        }}
      >
        {uploading && (
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${progress}%`, transition: 'width 0.4s ease',
            background: 'rgba(200,169,110,0.35)', borderRadius: '8px',
          }} />
        )}
        <span style={{ position: 'relative', zIndex: 1 }}>
          {uploading
            ? progress > 0 ? `Uploading… ${progress}%` : 'Starting…'
            : isFull ? 'Storage Full'
            : audioFile ? '⬆  Upload Track'
            : 'Select a File First'}
        </span>
      </button>

      {audioFile && !uploading && (
        <button type="button" onClick={reset} style={{
          background: 'none', border: 'none', cursor: 'pointer', color: '#444',
          fontFamily: 'monospace', fontSize: '9px', letterSpacing: '0.1em',
          textDecoration: 'underline', textAlign: 'center',
        }}>clear selection</button>
      )}
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

  const handleUploaded = useCallback(() => { fetchTracks(); fetchStorage(); }, [fetchTracks, fetchStorage]);

  const filtered = tracks.filter((t) => {
    const q = search.toLowerCase();
    return (t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q);
  });

  return (
    <>
      {/* Global keyframe styles */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes nowplaying { from { height: 30%; } to { height: 90%; } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      `}</style>

      <audio ref={audioRef} onEnded={() => setPlayingId(null)} style={{ display: 'none' }} />

      <div style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        background: '#0a0a0f', color: '#e0e0e0',
        fontFamily: 'monospace',
      }}>
        {/* Storage Bar */}
        <StorageBar storage={storage} />

        {/* Main 2-col split */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

          {/* ── Left: Track list 65% ── */}
          <div style={{
            flex: '0 0 65%', overflowY: 'auto', borderRight: '1px solid rgba(255,255,255,0.04)',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Search bar */}
            <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div style={{ position: 'relative' }}>
                <span style={{
                  position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)',
                  color: '#333', fontSize: '12px', pointerEvents: 'none',
                }}>⌕</span>
                <input
                  type="text"
                  placeholder="Search tracks…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    color: '#ccc', padding: '8px 10px 8px 28px',
                    borderRadius: '7px', fontFamily: 'monospace', fontSize: '11px',
                    outline: 'none', transition: 'border-color 0.2s',
                  }}
                  onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = 'rgba(200,169,110,0.4)'; }}
                  onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.06)'; }}
                />
              </div>
            </div>

            {/* Error banner */}
            {error && (
              <div style={{
                margin: '0 16px 8px', padding: '8px 10px', borderRadius: '7px',
                background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.2)',
                fontFamily: 'monospace', fontSize: '10px', color: '#f87171',
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>{error}</span>
                <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '11px' }}>✕</button>
              </div>
            )}

            {/* Track list body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px 16px' }}>
              {loading ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '200px', gap: '12px', opacity: 0.5 }}>
                  <div style={{ width: '20px', height: '20px', border: '2px solid #c8a96e', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <p style={{ fontFamily: 'monospace', fontSize: '9px', letterSpacing: '0.2em', color: '#555' }}>LOADING LIBRARY…</p>
                </div>
              ) : filtered.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '200px', gap: '10px' }}>
                  <div style={{ fontSize: '40px', opacity: 0.08 }}>◉</div>
                  <p style={{ fontFamily: 'monospace', fontSize: '12px', color: '#444' }}>
                    {search ? 'No results' : 'Library is empty'}
                  </p>
                  <p style={{ fontFamily: 'monospace', fontSize: '9px', color: '#2a2a2a', letterSpacing: '0.1em' }}>
                    {search ? 'Try a different search' : 'Upload a track using the form →'}
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {filtered.map((track, i) => (
                    <div key={track.id} style={{ animation: `fadeIn 0.25s ease ${i * 0.03}s both` }}>
                      <TrackCard
                        track={track}
                        onPlay={handlePlay}
                        onDelete={handleDelete}
                        onAddToPlaylist={(t) => setPlaylistModalTrack(t)}
                        isPlaying={playingId === track.id}
                        isLoading={loadingTrackId === track.id}
                      />
                    </div>
                  ))}
                  <p style={{ fontFamily: 'monospace', fontSize: '9px', color: '#333', textAlign: 'right', marginTop: '4px', letterSpacing: '0.1em' }}>
                    {filtered.length} track{filtered.length !== 1 ? 's' : ''}
                    {storage ? ` · ${storage.usedGB} GB used` : ''}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* ── Right: Upload sidebar 35% ── */}
          <div style={{
            flex: '0 0 35%', overflowY: 'auto',
            padding: '16px',
            background: 'rgba(255,255,255,0.01)',
            display: 'flex', flexDirection: 'column', gap: '4px',
          }}>
            <p style={{
              fontFamily: 'monospace', fontSize: '9px', letterSpacing: '0.2em',
              textTransform: 'uppercase', color: '#3a3a3a', marginBottom: '12px',
            }}>Upload to Library</p>
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
