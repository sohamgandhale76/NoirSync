import { useEffect, useState, useCallback, useRef } from 'react';
import { GlassPanel } from './ui/GlassPanel';
import { Button } from './ui/Button';
import { ProgressBar } from './ui/ProgressBar';
import { Spinner } from './ui/Spinner';
import { SERVER_URL } from '../lib/constants';
import { PlaylistBrowser } from './PlaylistBrowser';
import { AddToPlaylistModal } from './AddToPlaylistModal';

export interface LibraryTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: number | null;
  duration: number;
  bitrate: number;
  lossless: boolean;
  mimeType: string;
  fileSize: number;
  source?: string;
  fileIds?: string[] | null;
  filename: string;
  coverFilename: string | null;
  uploadedAt: number;
  originalExtension?: string;
  lrcText?: string;
}

export function resolveExtension(track?: LibraryTrack | null): string {
  if (!track) return '.mp3';
  if (track.originalExtension) return track.originalExtension;
  if (track.filename && track.filename.includes('.')) {
    return track.filename.substring(track.filename.lastIndexOf('.'));
  }
  const mime = (track.mimeType || '').toLowerCase();
  if (mime.includes('flac')) return '.flac';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('aac')) return '.aac';
  if (mime.includes('mp4') || mime.includes('m4a')) return '.m4a';
  return '.mp3';
}

interface LibraryBrowserProps {
  isHost: boolean;
  onHostTrack?: (trackId: string) => void;
  onHostTrackList?: (tracks: LibraryTrack[], startIndex: number) => void;
  onAddToQueue?: (track: LibraryTrack) => void;
  onAddTracksToQueue?: (tracks: LibraryTrack[]) => void;
  activeTrackId?: string | null;
}

export interface UploadTask {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'queued' | 'uploading' | 'processing' | 'completed' | 'failed';
  error?: string;
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function LibraryBrowser({
  isHost,
  onHostTrack,
  onHostTrackList,
  onAddToQueue,
  onAddTracksToQueue,
  activeTrackId,
}: LibraryBrowserProps) {
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingTrackId, setSyncingTrackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [subTab, setSubTab] = useState<'songs' | 'albums' | 'genres' | 'playlists'>('songs');
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null);
  const [playlistModalTrack, setPlaylistModalTrack] = useState<LibraryTrack | null>(null);

  // Batch upload states
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [showProgressPanel, setShowProgressPanel] = useState(true);
  const [dragOverLibrary, setDragOverLibrary] = useState(false);

  const fileRef = useRef<Map<string, File>>(new Map());
  const runningUploadsRef = useRef<Set<string>>(new Set());
  const lrcFilesMapRef = useRef<Map<string, File>>(new Map());


  const fetchTracks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${SERVER_URL || ''}/api/library/tracks`);
      if (!res.ok) throw new Error('Failed to load library catalog');
      const data = await res.json();
      // Filter out any test/dummy entries that have no real track properties
      const realTracks = (data.tracks || []).filter((t: any) => t.id && t.title && !t.test);
      setTracks(realTracks);
    } catch (err: any) {
      setError(err.message || 'Could not fetch catalog.');
    } finally {
      setLoading(false);
    }
  }, []);



  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  // Concurrent Upload Queue Runner (Max 2 uploads)
  useEffect(() => {
    const activeCount = uploadTasks.filter(
      (t) => (t.status === 'uploading' || t.status === 'processing') || runningUploadsRef.current.has(t.id)
    ).length;
    if (activeCount >= 2) return;

    const queuedTask = uploadTasks.find(
      (t) => t.status === 'queued' && !runningUploadsRef.current.has(t.id)
    );
    if (!queuedTask) return;

    const taskId = queuedTask.id;
    runningUploadsRef.current.add(taskId);

    const file = fileRef.current.get(taskId);
    if (!file) {
      runningUploadsRef.current.delete(taskId);
      setUploadTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, status: 'failed', error: 'File not found' } : t
        )
      );
      return;
    }

    // Run async upload in a fire-and-forget IIFE
    (async () => {
    // Set task to uploading
    setUploadTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: 'uploading' } : t))
    );

    const formData = new FormData();
    formData.append('file', file);

    // Step 1: POST the file — server responds immediately with jobId
    // (avoids Render's 30s HTTP timeout; Telegram chunking happens in background)
    let jobId: string | null = null;
    try {
      const uploadRes = await fetch(`${SERVER_URL || ''}/api/library/upload`, {
        method: 'POST',
        body: formData,
      });
      const uploadData = await uploadRes.json();

      if (!uploadRes.ok) {
        throw new Error(uploadData.error || 'Upload failed');
      }

      // If server returned a track directly (legacy / local-only mode)
      if (uploadData.track) {
        const trackId = uploadData.track.id;
        const lrcFile = lrcFilesMapRef.current.get(taskId);
        if (lrcFile && trackId) {
          try {
            const text = await lrcFile.text();
            await fetch(`${SERVER_URL || ''}/api/library/tracks/${trackId}/lrc`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lrcText: text }),
            });
          } catch (lrcErr) {
            console.error('Failed to auto-associate lyrics:', lrcErr);
          } finally {
            lrcFilesMapRef.current.delete(taskId);
          }
        }
        runningUploadsRef.current.delete(taskId);
        setUploadTasks((prev) =>
          prev.map((t) => t.id === taskId ? { ...t, status: 'completed', progress: 100 } : t)
        );
        fetchTracks();
        return;
      }

      jobId = uploadData.jobId;
    } catch (err: any) {
      runningUploadsRef.current.delete(taskId);
      setUploadTasks((prev) =>
        prev.map((t) => t.id === taskId ? { ...t, status: 'failed', error: err.message || 'Upload failed' } : t)
      );
      return;
    }

    // Step 2: Switch to 'processing' and poll until the background job finishes
    setUploadTasks((prev) =>
      prev.map((t) => t.id === taskId ? { ...t, progress: 100, status: 'processing' } : t)
    );

    const poll = async () => {
      const MAX_WAIT_MS = 15 * 60 * 1000; // 15 min max
      const POLL_INTERVAL = 3000;
      const started = Date.now();

      while (Date.now() - started < MAX_WAIT_MS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        try {
          const jobRes = await fetch(`${SERVER_URL || ''}/api/library/jobs/${jobId}`);
          const job = await jobRes.json();

          if (job.status === 'done') {
            const trackId = job.track?.id;
            const lrcFile = lrcFilesMapRef.current.get(taskId);
            if (lrcFile && trackId) {
              try {
                const text = await lrcFile.text();
                await fetch(`${SERVER_URL || ''}/api/library/tracks/${trackId}/lrc`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ lrcText: text }),
                });
              } catch (lrcErr) {
                console.error('Failed to auto-associate lyrics:', lrcErr);
              } finally {
                lrcFilesMapRef.current.delete(taskId);
              }
            }
            runningUploadsRef.current.delete(taskId);
            setUploadTasks((prev) =>
              prev.map((t) => t.id === taskId ? { ...t, status: 'completed', progress: 100 } : t)
            );
            fetchTracks();
            return;
          }

          if (job.status === 'failed') {
            runningUploadsRef.current.delete(taskId);
            setUploadTasks((prev) =>
              prev.map((t) => t.id === taskId ? { ...t, status: 'failed', error: job.error || 'Upload failed on server' } : t)
            );
            return;
          }
          // still 'processing' — keep polling
        } catch {
          // network hiccup — keep trying
        }
      }

      // Timed out waiting
      runningUploadsRef.current.delete(taskId);
      setUploadTasks((prev) =>
        prev.map((t) => t.id === taskId ? { ...t, status: 'failed', error: 'Timed out waiting for cloud upload to complete' } : t)
      );
    };

    poll();
    })();
  }, [uploadTasks, fetchTracks]);

  const addFilesToQueue = useCallback((allFiles: File[]) => {
    const audioFiles = allFiles.filter(f => !(f?.name || '').toLowerCase().endsWith('.lrc'));
    const lrcFiles = allFiles.filter(f => (f?.name || '').toLowerCase().endsWith('.lrc'));

    const lrcMap = new Map<string, File>();
    lrcFiles.forEach(f => {
      if (!f?.name) return;
      const idx = f.name.lastIndexOf('.');
      const base = idx !== -1 ? f.name.substring(0, idx).toLowerCase() : f.name.toLowerCase();
      lrcMap.set(base, f);
    });

    const newTasks: UploadTask[] = [];
    audioFiles.forEach((file) => {
      if (!file) return;
      const id = Math.random().toString(36).substring(7) + '_' + Date.now();
      fileRef.current.set(id, file);

      // Check for associated LRC file
      const idx = file.name ? file.name.lastIndexOf('.') : -1;
      const base = idx !== -1 ? file.name.substring(0, idx).toLowerCase() : (file.name || '').toLowerCase();
      const lrcFile = lrcMap.get(base);
      if (lrcFile) {
        lrcFilesMapRef.current.set(id, lrcFile);
      }

      newTasks.push({
        id,
        name: file.name,
        size: file.size,
        progress: 0,
        status: 'queued',
      });
    });

    setUploadTasks((prev) => [...prev, ...newTasks]);
    setShowProgressPanel(true);
  }, []);

  // Recursive Directory / File Scanner
  const scanFileEntry = async (entry: any): Promise<File[]> => {
    const files: File[] = [];
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        entry.file(resolve, reject);
      });
      const isAcceptable =
        file.type.startsWith('audio/') ||
        /\.(mp3|flac|wav|m4a|ogg|aac|lrc)$/i.test(file.name);
      if (isAcceptable) {
        files.push(file);
      }
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const readAllEntries = async (): Promise<any[]> => {
        const allEntries: any[] = [];
        const read = async () => {
          const entries = await new Promise<any[]>((resolve, reject) => {
            dirReader.readEntries(resolve, reject);
          });
          if (entries.length > 0) {
            allEntries.push(...entries);
            await read();
          }
        };
        await read();
        return allEntries;
      };

      try {
        const entries = await readAllEntries();
        for (const subEntry of entries) {
          const subFiles = await scanFileEntry(subEntry);
          files.push(...subFiles);
        }
      } catch (err) {
        console.error('Failed to read directory entries:', err);
      }
    }
    return files;
  };

  const handleLibraryDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverLibrary(false);

    const items = Array.from(e.dataTransfer.items || []);
    const files: File[] = [];

    for (const item of items) {
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          const scanned = await scanFileEntry(entry);
          files.push(...scanned);
        }
      }
    }

    if (files.length === 0 && e.dataTransfer.files) {
      // Fallback for regular files
      const rawFiles = Array.from(e.dataTransfer.files).filter(
        (f) => f.type.startsWith('audio/') || /\.(mp3|flac|wav|m4a|ogg|aac|lrc)$/i.test(f.name)
      );
      files.push(...rawFiles);
    }

    if (files.length > 0) {
      addFilesToQueue(files);
    }
  };

  const handleDeleteTrack = async (trackId: string) => {
    if (!window.confirm('Are you sure you want to delete this track from the library?')) return;
    try {
      const res = await fetch(`${SERVER_URL || ''}/api/library/tracks/${trackId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete track');
      await fetchTracks();
    } catch (err: any) {
      setError(err.message || 'Failed to delete track');
    }
  };

  const handleSyncToTelegram = async (trackId: string) => {
    setSyncingTrackId(trackId);
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL || ''}/api/library/tracks/${trackId}/sync`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to sync track');
      await fetchTracks();
    } catch (err: any) {
      setError(err.message || 'Failed to sync track to Telegram');
    } finally {
      setSyncingTrackId(null);
    }
  };

  const handleLrcUpload = async (trackId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      const res = await fetch(`${SERVER_URL || ''}/api/library/tracks/${trackId}/lrc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lrcText: text }),
      });
      if (!res.ok) throw new Error('Failed to upload lyrics');
      await fetchTracks();
    } catch (err: any) {
      setError(err.message || 'Failed to upload lyrics (.lrc)');
    }
  };

  const clearUploadPanel = () => {
    setUploadTasks((prev) => prev.filter((t) => t.status === 'queued' || t.status === 'uploading' || t.status === 'processing'));
  };

  const filteredTracks = tracks.filter((t) => {
    if (!t) return false;
    const term = (searchQuery || '').toLowerCase();
    return (
      (t.title || '').toLowerCase().includes(term) ||
      (t.artist || '').toLowerCase().includes(term) ||
      (t.album || '').toLowerCase().includes(term)
    );
  });

  const getGenreGradient = (genre: string) => {
    let hash = 0;
    for (let i = 0; i < genre.length; i++) {
      hash = genre.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h1 = Math.abs(hash % 360);
    const h2 = (h1 + 45) % 360;
    return `linear-gradient(135deg, hsl(${h1}, 45%, 22%), hsl(${h2}, 50%, 12%))`;
  };

  const albumsMap = new Map<string, LibraryTrack[]>();
  tracks.forEach((t) => {
    const key = t.album ? t.album.trim() : 'Unknown Album';
    if (!albumsMap.has(key)) albumsMap.set(key, []);
    albumsMap.get(key)!.push(t);
  });

  const albumsList = Array.from(albumsMap.entries()).map(([name, albumTracks]) => {
    const sampleTrack = albumTracks.find((t) => t.coverFilename !== null) || albumTracks[0];
    const artist = albumTracks[0]?.artist || 'Unknown Artist';
    return {
      name,
      tracks: albumTracks,
      coverFilename: sampleTrack?.coverFilename || null,
      artist,
    };
  }).filter((a) => {
    if (!a) return false;
    if (!searchQuery) return true;
    const term = (searchQuery || '').toLowerCase();
    return (
      (a.name || '').toLowerCase().includes(term) ||
      (a.artist || '').toLowerCase().includes(term)
    );
  });

  const genresMap = new Map<string, LibraryTrack[]>();
  tracks.forEach((t) => {
    const list = t.genre
      ? t.genre.split(',').map((g) => g.trim()).filter(Boolean)
      : ['Other'];
    const finalGenres = list.length > 0 ? list : ['Other'];
    finalGenres.forEach((g) => {
      if (!genresMap.has(g)) genresMap.set(g, []);
      genresMap.get(g)!.push(t);
    });
  });

  const genresList = Array.from(genresMap.entries()).map(([name, genreTracks]) => {
    return {
      name,
      tracks: genreTracks,
    };
  }).filter((g) => {
    if (!g) return false;
    if (!searchQuery) return true;
    return (g.name || '').toLowerCase().includes((searchQuery || '').toLowerCase());
  });

  const handleHostTrackListAction = (trackList: LibraryTrack[]) => {
    if (onHostTrackList && trackList.length > 0) {
      onHostTrackList(trackList, 0);
    }
  };

  const handleQueueTrackListAction = (trackList: LibraryTrack[]) => {
    if (onAddTracksToQueue && trackList.length > 0) {
      onAddTracksToQueue(trackList);
    }
  };

  const selectedAlbumData = selectedAlbum ? albumsMap.get(selectedAlbum) : null;
  const selectedGenreData = selectedGenre ? genresMap.get(selectedGenre) : null;

  const totalUploadingCount = uploadTasks.filter((t) => t.status === 'uploading' || t.status === 'queued' || t.status === 'processing').length;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOverLibrary(true);
      }}
      onDragLeave={() => setDragOverLibrary(false)}
      onDrop={handleLibraryDrop}
      className={`space-y-6 min-h-[50vh] transition-all rounded-xl p-1 ${
        dragOverLibrary
          ? 'outline-2 outline-dashed outline-accent-gold/45 bg-accent-gold/5'
          : ''
      }`}
    >
      {dragOverLibrary && (
        <div className="pointer-events-none text-center py-6 text-accent-gold font-mono text-xs uppercase tracking-widest animate-pulse">
          Drop folders or audio files anywhere here to import into persistent library
        </div>
      )}

      {/* Visual upload drop box */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => document.getElementById('library-drop-input')?.click()}
        onKeyDown={(e) => e.key === 'Enter' && document.getElementById('library-drop-input')?.click()}
        className="border border-dashed border-accent-gold/40 hover:border-accent-gold bg-accent-gold/[0.02] hover:bg-accent-gold/[0.06] rounded-xl p-6 text-center cursor-pointer transition-all duration-300 group shadow-sm hover:shadow-accent-gold/5"
      >
        <div className="text-2xl mb-1.5 transition-transform group-hover:scale-110 text-accent-gold">📥</div>
        <p className="font-ui text-xs text-accent-gold font-semibold uppercase tracking-wider">Drop MP3 / WAV here + .lrc file for lyrics</p>
        <p className="font-mono text-[9px] text-noir-ash mt-1">Click to browse or drop files & folders</p>
        <input
          id="library-drop-input"
          type="file"
          accept="audio/*,.lrc"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            addFilesToQueue(files);
          }}
        />
      </div>

      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
          <div className="w-full sm:max-w-xs relative">
            <input
              type="text"
              placeholder={`Search in ${subTab}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-noir-graphite border border-noir-border text-noir-white px-4 py-2.5 rounded-lg font-ui text-sm focus:outline-none focus:border-accent-gold/60 focus:ring-2 focus:ring-accent-gold/20 transition-all placeholder:text-noir-dim"
            />
          </div>

          <div className="flex bg-noir-graphite/60 border border-noir-border/50 p-1 rounded-lg self-stretch sm:self-auto">
            {(['songs', 'albums', 'genres', 'playlists'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => {
                  setSubTab(tab);
                  setSelectedAlbum(null);
                  setSelectedGenre(null);
                }}
                className={`px-4 py-1.5 rounded-md font-ui text-xs font-medium uppercase tracking-wider transition-all ${
                  subTab === tab
                    ? 'bg-accent-gold/15 text-accent-gold border border-accent-gold/25'
                    : 'text-noir-dim hover:text-noir-white border border-transparent'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Interactive Library Upload triggers */}
          <div className="flex gap-2.5 w-full sm:w-auto flex-wrap">
            <label className="flex-1 sm:flex-none">
              <input
                type="file"
                accept="audio/*,.lrc"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  addFilesToQueue(files);
                }}
              />
              <span className="btn-noir btn-gold w-full text-center py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 cursor-pointer select-none font-ui text-xs font-medium uppercase tracking-wider">
                📤 Upload Files
              </span>
            </label>

            <label className="flex-1 sm:flex-none">
              <input
                type="file"
                accept="audio/*,.lrc"
                {...({ webkitdirectory: '', directory: '' } as any)}
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []).filter(
                    (file) =>
                      file.type.startsWith('audio/') ||
                      /\.(mp3|flac|wav|m4a|ogg|aac|lrc)$/i.test(file.name)
                  );
                  addFilesToQueue(files);
                }}
              />
              <span className="btn-noir btn-gold w-full text-center py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 cursor-pointer select-none font-ui text-xs font-medium uppercase tracking-wider">
                📂 Upload Folder
              </span>
            </label>


          </div>
        </div>



        {error && (
          <div className="p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-400 font-ui text-sm">
            {error}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Spinner size="lg" />
          <p className="font-mono text-xs text-noir-dim tracking-widest uppercase">
            Loading Catalog...
          </p>
        </div>
      ) : subTab === 'playlists' ? (
        <PlaylistBrowser
          isHost={isHost}
          onPlayTrack={(track) => {
            if (onHostTrack) onHostTrack(track.id);
          }}
          onAddToQueue={(track) => {
            if (onAddToQueue) {
              const libTrack = tracks.find((t) => t.id === track.id) || {
                id: track.id,
                title: track.title,
                artist: track.artist || 'Unknown Artist',
                album: track.album || 'Single',
                genre: 'Various',
                year: null,
                duration: track.duration,
                bitrate: 320,
                lossless: false,
                mimeType: track.format === 'flac' ? 'audio/flac' : 'audio/mpeg',
                fileSize: track.size || 0,
                filename: track.id,
                coverFilename: track.cover_key || null,
                uploadedAt: Date.now(),
              };
              onAddToQueue(libTrack);
            }
          }}
          onLoadPlaylistToRoomQueue={(pTracks) => {
            if (onAddTracksToQueue && pTracks.length > 0) {
              const libTracks = pTracks.map((pt) => {
                const match = tracks.find((t) => t.id === pt.id);
                return (
                  match || {
                    id: pt.id,
                    title: pt.title,
                    artist: pt.artist || 'Unknown Artist',
                    album: pt.album || 'Single',
                    genre: 'Various',
                    year: null,
                    duration: pt.duration,
                    bitrate: 320,
                    lossless: false,
                    mimeType: pt.format === 'flac' ? 'audio/flac' : 'audio/mpeg',
                    fileSize: pt.size || 0,
                    filename: pt.id,
                    coverFilename: (pt.has_cover || pt.cover_key) ? (pt.cover_key && pt.cover_key.startsWith('r2-') ? pt.cover_key : `r2-${pt.id}`) : null,
                    uploadedAt: Date.now(),
                  }
                );
              });
              onAddTracksToQueue(libTracks);
            }
          }}
        />
      ) : (
        <>
          {subTab === 'songs' && (
            <>
              {filteredTracks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3 border border-dashed border-noir-border rounded-xl">
                  <p className="text-4xl opacity-20">📭</p>
                  <p className="font-display text-lg text-noir-ash">No songs in library</p>
                  <p className="font-mono text-xs text-noir-dim">
                    {searchQuery
                      ? 'Try broadening your search'
                      : 'Upload or drag and drop audio files/folders to import'}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredTracks.map((track) => (
                    <GlassPanel
                      key={track.id}
                      className={`p-4 flex gap-4 transition-all duration-300 relative group ${
                        activeTrackId === track.id
                          ? 'border-accent-gold shadow-noir-glow'
                          : 'hover:border-noir-dim/40'
                      }`}
                    >
                      <div className="w-16 h-16 rounded-md overflow-hidden bg-noir-graphite flex-shrink-0 flex items-center justify-center border border-noir-border relative">
                        {track.coverFilename ? (
                          <img
                            src={`${SERVER_URL || ''}/api/library/covers/${track.coverFilename}`}
                            alt="Cover"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <span className="text-3xl opacity-35">🎵</span>
                        )}
                      </div>

                      <div className="flex-1 min-w-0 flex flex-col justify-between">
                        <div>
                          <h3 className="font-ui text-sm font-semibold text-noir-white truncate" title={track.title}>
                            {track.title}
                          </h3>
                          <p className="font-ui text-xs text-noir-ash truncate mt-0.5">
                            {track.artist} • {track.album || 'Single'}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <span
                            className={`font-mono text-[9px] px-2 py-0.5 rounded-full border ${
                              track.lossless
                                ? 'border-green-800/40 bg-green-950/20 text-green-400'
                                : 'border-yellow-800/40 bg-yellow-950/20 text-yellow-400'
                            }`}
                          >
                            {track.lossless ? 'LOSSLESS' : `${track.bitrate}KBPS`}
                          </span>

                          {track.source === 'telegram' && (
                            <span className="font-mono text-[9px] px-2 py-0.5 rounded-full border border-sky-850/40 bg-sky-950/20 text-sky-400">
                              ☁ TELEGRAM
                            </span>
                          )}

                          {track.lrcText ? (
                            <span className="font-mono text-[9px] px-2 py-0.5 rounded-full border border-accent-gold/40 bg-accent-gold/10 text-accent-gold flex items-center gap-0.5">
                              📝 LYRICS
                            </span>
                          ) : (
                            isHost && (
                              <label className="font-mono text-[9px] px-2 py-0.5 rounded-full border border-noir-border hover:border-accent-gold/40 hover:text-accent-gold bg-noir-graphite/40 text-noir-dim cursor-pointer transition-all flex items-center gap-0.5">
                                ➕ LRC
                                <input
                                  type="file"
                                  accept=".lrc"
                                  className="hidden"
                                  onChange={(e) => handleLrcUpload(track.id, e)}
                                />
                              </label>
                            )
                          )}

                          <span className="font-mono text-[10px] text-noir-dim">
                            {formatTime(track.duration)}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5 justify-center z-10">
                        {isHost && onHostTrack && (
                          <Button
                            variant={activeTrackId === track.id ? 'default' : 'gold'}
                            size="sm"
                            className="whitespace-nowrap py-1 h-8"
                            onClick={() => onHostTrack(track.id)}
                            disabled={activeTrackId === track.id}
                          >
                            {activeTrackId === track.id ? 'Hosting' : '⚡ Host'}
                          </Button>
                        )}

                        {isHost && onAddToQueue && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="whitespace-nowrap border border-noir-border hover:border-accent-gold/40 text-[11px] py-1 h-7"
                            onClick={() => onAddToQueue(track)}
                          >
                            ➕ Queue
                          </Button>
                        )}

                        <Button
                          variant="ghost"
                          size="sm"
                          className="whitespace-nowrap border border-noir-border hover:border-accent-gold/40 text-accent-gold text-[11px] py-1 h-7"
                          onClick={() => setPlaylistModalTrack(track)}
                          title="Add to playlist"
                        >
                          📋 Playlist
                        </Button>

                        {isHost && track.source !== 'telegram' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="whitespace-nowrap border border-sky-900/40 hover:border-sky-500/40 text-sky-400 text-[10px] py-1 h-7"
                            onClick={() => handleSyncToTelegram(track.id)}
                            disabled={syncingTrackId !== null}
                          >
                            {syncingTrackId === track.id ? '☁ Syncing...' : '☁ Sync Cloud'}
                          </Button>
                        )}

                        <div className="flex gap-1">
                          <a
                            href={`${SERVER_URL || ''}/api/library/tracks/${track.id}/download/${encodeURIComponent(track.title)}${resolveExtension(track)}`}
                            download={`${track.title}${resolveExtension(track)}`}
                            className="btn-noir text-[10px] py-1 h-7 px-2 flex-1 text-center rounded-lg flex items-center justify-center gap-0.5 border border-noir-border text-noir-ash hover:text-noir-white"
                            title="Download raw audio file"
                          >
                            ⬇ Get
                          </a>

                          {isHost && (
                            <button
                              onClick={() => handleDeleteTrack(track.id)}
                              className="btn-noir text-[10px] py-1 h-7 px-2 border border-red-900/40 text-red-400 hover:text-red-300 hover:bg-red-950/20 rounded-lg flex items-center justify-center"
                              title="Delete song"
                            >
                              🗑 Delete
                            </button>
                          )}
                        </div>
                      </div>
                    </GlassPanel>
                  ))}
                </div>
              )}
            </>
          )}

          {subTab === 'albums' && (
            <>
              {albumsList.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3 border border-dashed border-noir-border rounded-xl">
                  <p className="text-4xl opacity-20">💿</p>
                  <p className="font-display text-lg text-noir-ash">No albums found</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">
                  {albumsList.map((album) => (
                    <div
                      key={album.name}
                      onClick={() => setSelectedAlbum(album.name)}
                      className="group cursor-pointer space-y-3 p-3 rounded-xl border border-transparent hover:border-noir-border/50 hover:bg-noir-deep/30 transition-all duration-300"
                    >
                      <div className="aspect-square w-full rounded-lg bg-noir-graphite border border-noir-border/60 overflow-hidden flex items-center justify-center relative shadow-md shadow-black/40 group-hover:scale-[1.02] transition-transform duration-300">
                        {album.coverFilename ? (
                          <img
                            src={`${SERVER_URL || ''}/api/library/covers/${album.coverFilename}`}
                            alt={album.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <span className="text-5xl opacity-35">💿</span>
                        )}
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity duration-200">
                          <span className="font-mono text-xs text-accent-gold uppercase tracking-widest border border-accent-gold/45 px-3 py-1 rounded-full bg-noir-black/80">
                            View Album
                          </span>
                        </div>
                      </div>
                      <div className="min-w-0">
                        <h4 className="font-ui font-semibold text-sm text-noir-white truncate group-hover:text-accent-gold transition-colors">
                          {album.name}
                        </h4>
                        <p className="font-ui text-xs text-noir-dim truncate mt-0.5">
                          {album.artist}
                        </p>
                        <p className="font-mono text-[10px] text-accent-gold/60 mt-1 uppercase tracking-wider">
                          {album.tracks.length} song{album.tracks.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {subTab === 'genres' && (
            <>
              {genresList.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3 border border-dashed border-noir-border rounded-xl">
                  <p className="text-4xl opacity-20">🏷</p>
                  <p className="font-display text-lg text-noir-ash">No categories found</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {genresList.map((genre) => (
                    <div
                      key={genre.name}
                      onClick={() => setSelectedGenre(genre.name)}
                      className="cursor-pointer h-28 rounded-xl p-5 flex flex-col justify-between border border-noir-border/30 hover:border-accent-gold/50 shadow-lg hover:shadow-accent-gold/5 hover:scale-[1.02] transition-all duration-300 relative overflow-hidden group"
                      style={{ background: getGenreGradient(genre.name) }}
                    >
                      <div className="absolute right-0 bottom-0 text-7xl opacity-[0.08] select-none translate-x-3 translate-y-3 group-hover:rotate-12 transition-transform duration-300">
                        🏷
                      </div>

                      <span className="font-display text-lg font-bold text-noir-white drop-shadow-md">
                        {genre.name}
                      </span>
                      <div className="flex items-center justify-between z-10">
                        <span className="font-mono text-[10px] text-noir-white/80 uppercase tracking-widest bg-black/30 px-2 py-0.5 rounded-full border border-white/5">
                          {genre.tracks.length} track{genre.tracks.length !== 1 ? 's' : ''}
                        </span>
                        <span className="text-accent-gold text-xs opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          Listen →
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Album or Genre overlay drawer details */}
      {(selectedAlbumData || selectedGenreData) && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-md flex items-center justify-end z-[100] animate-fade-in">
          <div
            className="absolute inset-0"
            onClick={() => {
              setSelectedAlbum(null);
              setSelectedGenre(null);
            }}
          />

          <div className="relative w-full max-w-2xl h-full bg-noir-deep border-l border-noir-border/60 shadow-2xl flex flex-col z-10 animate-slide-in-right">
            <div className="p-6 border-b border-noir-border/50 flex justify-between items-start gap-4">
              <div className="flex gap-4">
                {selectedAlbumData && (
                  <div className="w-20 h-20 rounded-lg bg-noir-graphite border border-noir-border flex-shrink-0 flex items-center justify-center overflow-hidden">
                    {selectedAlbumData.find((t) => t.coverFilename !== null)?.coverFilename ? (
                      <img
                        src={`${SERVER_URL || ''}/api/library/covers/${
                          selectedAlbumData.find((t) => t.coverFilename !== null)!.coverFilename
                        }`}
                        alt="Album art"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-4xl opacity-35">💿</span>
                    )}
                  </div>
                )}
                <div>
                  <span className="font-mono text-[9px] uppercase tracking-wider text-accent-gold border border-accent-gold/30 px-2 py-0.5 rounded">
                    {selectedAlbumData ? 'Album Details' : 'Category Details'}
                  </span>
                  <h2 className="font-display text-2xl font-bold text-noir-white mt-1.5">
                    {selectedAlbum || selectedGenre}
                  </h2>
                  <p className="font-ui text-xs text-noir-dim mt-1">
                    {selectedAlbumData
                      ? `By ${selectedAlbumData[0]?.artist || 'Unknown'} • ${selectedAlbumData.length} songs`
                      : `${selectedGenreData?.length || 0} songs under this tag`}
                  </p>
                </div>
              </div>

              <button
                onClick={() => {
                  setSelectedAlbum(null);
                  setSelectedGenre(null);
                }}
                className="text-noir-dim hover:text-noir-white font-mono text-xl p-1.5 hover:bg-noir-graphite rounded-lg transition-all"
              >
                ✕
              </button>
            </div>

            {isHost && (
              <div className="px-6 py-3.5 bg-noir-graphite/40 border-b border-noir-border/30 flex gap-3">
                <Button
                  variant="gold"
                  size="sm"
                  onClick={() => handleHostTrackListAction(selectedAlbumData || selectedGenreData || [])}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 font-semibold"
                >
                  ⚡ Host Entire Set
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleQueueTrackListAction(selectedAlbumData || selectedGenreData || [])}
                  className="flex-1 border border-noir-border hover:border-accent-gold/40 text-noir-white flex items-center justify-center gap-1.5 py-2"
                >
                  ➕ Add All to Queue
                </Button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-6 space-y-3">
              {(selectedAlbumData || selectedGenreData || []).map((track, idx) => (
                <div
                  key={track.id}
                  className={`p-3 rounded-lg border border-noir-border/40 hover:border-accent-gold/30 bg-noir-graphite/25 flex items-center justify-between gap-4 transition-all ${
                    activeTrackId === track.id ? 'border-accent-gold bg-accent-gold/5' : ''
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-xs text-noir-dim w-5 text-center shrink-0">
                      {idx + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="font-ui text-sm font-semibold text-noir-white truncate">
                        {track.title}
                      </p>
                      <p className="font-ui text-xs text-noir-dim truncate mt-0.5">
                        {track.artist}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-mono text-xs text-noir-dim">
                      {formatTime(track.duration)}
                    </span>

                    {isHost && onHostTrack && (
                      <button
                        onClick={() => onHostTrack(track.id)}
                        disabled={activeTrackId === track.id}
                        className={`text-xs px-2.5 py-1 rounded font-ui font-medium transition-all ${
                          activeTrackId === track.id
                            ? 'text-accent-gold bg-accent-gold/15'
                            : 'text-noir-white bg-noir-graphite border border-noir-border hover:border-accent-gold/55 hover:text-accent-gold'
                        }`}
                      >
                        {activeTrackId === track.id ? 'Playing' : 'Play'}
                      </button>
                    )}

                    <button
                      onClick={() => setPlaylistModalTrack(track)}
                      className="text-xs px-2 py-1 rounded font-ui font-medium text-noir-ash bg-noir-graphite border border-noir-border hover:border-accent-gold/55 hover:text-accent-gold transition-all"
                      title="Add to playlist"
                    >
                      📋 Playlist
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Floating Collapsible Upload Progress Task Panel */}
      {uploadTasks.length > 0 && (
        <div className="fixed bottom-6 right-6 w-80 max-w-sm z-50 animate-slide-in-right shadow-2xl">
          <GlassPanel className="border border-accent-gold/30 bg-noir-deep/95 backdrop-blur-md rounded-xl overflow-hidden flex flex-col max-h-96">
            {/* Header */}
            <div className="px-4 py-3 bg-noir-black/40 border-b border-noir-border/50 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2">
                {totalUploadingCount > 0 ? (
                  <Spinner size="sm" />
                ) : (
                  <span className="text-xs">📊</span>
                )}
                <span className="font-ui text-xs font-semibold text-noir-white">
                  Library Uploads ({totalUploadingCount} active)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={clearUploadPanel}
                  className="font-mono text-[9px] text-noir-ash hover:text-noir-white transition-colors"
                  title="Clear finished tasks"
                >
                  CLEAR
                </button>
                <button
                  onClick={() => setShowProgressPanel(!showProgressPanel)}
                  className="text-noir-white font-mono text-xs px-1.5 py-0.5 hover:bg-noir-graphite rounded"
                >
                  {showProgressPanel ? '▼' : '▲'}
                </button>
              </div>
            </div>

            {/* List */}
            {showProgressPanel && (
              <div className="flex-1 overflow-y-auto p-3 space-y-3.5 min-h-[100px]">
                {uploadTasks.map((task) => (
                  <div key={task.id} className="space-y-1">
                    <div className="flex justify-between items-start gap-2 text-[11px] font-ui">
                      <span className="text-noir-white truncate w-48" title={task.name}>
                        {task.name}
                      </span>
                      <span
                        className={`font-mono text-[9px] shrink-0 ${
                          task.status === 'completed'
                            ? 'text-green-400'
                            : task.status === 'failed'
                            ? 'text-red-400'
                            : task.status === 'processing'
                            ? 'text-sky-400 animate-pulse'
                            : 'text-accent-gold'
                        }`}
                      >
                        {task.status === 'completed' && '✓'}
                        {task.status === 'failed' && '✕'}
                        {task.status === 'uploading' && `${task.progress}%`}
                        {task.status === 'processing' && '☁ cloud...'}
                        {task.status === 'queued' && 'queued'}
                      </span>
                    </div>

                    {task.status === 'processing' && (
                      <p className="text-[9px] font-mono text-sky-400/80 animate-pulse leading-normal">
                        Uploading to cloud storage — please wait, do not close this tab…
                      </p>
                    )}

                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <ProgressBar
                          value={task.progress}
                          className={
                            task.status === 'completed'
                              ? 'bg-green-500/20'
                              : task.status === 'failed'
                              ? 'bg-red-500/20'
                              : task.status === 'processing'
                              ? 'bg-sky-500/20'
                              : ''
                          }
                        />
                      </div>
                      <span className="font-mono text-[9px] text-noir-dim shrink-0">
                        {(task.size / 1024 / 1024).toFixed(1)}MB
                      </span>
                    </div>

                    {task.error && (
                      <p className="text-[9px] font-mono text-red-400 leading-normal truncate" title={task.error}>
                        Error: {task.error}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </GlassPanel>
        </div>
      )}

      <AddToPlaylistModal
        track={playlistModalTrack}
        isOpen={!!playlistModalTrack}
        onClose={() => setPlaylistModalTrack(null)}
      />
    </div>
  );
}
