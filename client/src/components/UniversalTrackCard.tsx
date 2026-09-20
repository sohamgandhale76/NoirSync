import { UniversalTrack } from '../hooks/useUniversalCatalog';
import { Button } from './ui/Button';
import { SERVER_URL } from '../lib/constants';

interface UniversalTrackCardProps {
  track: UniversalTrack;
  onPlay?: (track: UniversalTrack) => void;
  onAddToPlaylist: (track: UniversalTrack) => void;
  isPlaying?: boolean;
}

function formatDuration(secs: number | null): string {
  if (!secs || isNaN(secs)) return '--:--';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getProviderBadge(provider: string) {
  switch (provider.toLowerCase()) {
    case 'spotify':
      return {
        label: 'Spotify',
        bg: 'bg-[#1DB954]/15 border-[#1DB954]/30 text-[#1DB954]',
        icon: '🟢'
      };
    case 'youtube':
      return {
        label: 'YouTube',
        bg: 'bg-[#FF0000]/15 border-[#FF0000]/30 text-[#FF4444]',
        icon: '▶️'
      };
    case 'apple':
      return {
        label: 'Apple Music',
        bg: 'bg-[#FC3C44]/15 border-[#FC3C44]/30 text-[#FC3C44]',
        icon: '🍎'
      };
    case 'noirsync_public':
      return {
        label: 'NoirSync Public',
        bg: 'bg-accent-gold/15 border-accent-gold/30 text-accent-gold',
        icon: '🌐'
      };
    default:
      return {
        label: provider,
        bg: 'bg-noir-graphite border-noir-border text-noir-ash',
        icon: '🎵'
      };
  }
}

export function UniversalTrackCard({
  track,
  onPlay,
  onAddToPlaylist,
  isPlaying = false,
}: UniversalTrackCardProps) {
  const badge = getProviderBadge(track.provider);
  const { capabilities } = track;

  const handleDownload = () => {
    if (!capabilities.download || !track.id) return;
    const downloadUrl = `${SERVER_URL || ''}/api/catalog/tracks/${track.id}/download`;
    window.open(downloadUrl, '_blank');
  };

  return (
    <div className="group relative p-4 rounded-xl bg-noir-surface/70 border border-noir-border/50 hover:border-noir-border/80 hover:bg-noir-surface/90 transition-all duration-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
      {/* Left: Artwork + Details */}
      <div className="flex items-center gap-3.5 min-w-0 flex-1">
        {/* Artwork */}
        <div className="relative w-14 h-14 rounded-lg bg-noir-graphite border border-noir-border/40 overflow-hidden shrink-0 flex items-center justify-center">
          {track.coverUrl ? (
            <img
              src={track.coverUrl}
              alt={track.title}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <span className="text-xl opacity-40">{badge.icon}</span>
          )}

          {/* Overlay Play trigger if streamable */}
          {capabilities.playback === 'noirsync_stream' && onPlay && (
            <button
              onClick={() => onPlay(track)}
              className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-accent-gold hover:scale-110"
              title="Play track"
            >
              {isPlaying ? '⏸' : '▶'}
            </button>
          )}
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="font-display font-semibold text-sm text-noir-white truncate">
              {track.title}
            </h4>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-mono border uppercase tracking-wider shrink-0 ${badge.bg}`}>
              {badge.label}
            </span>
          </div>

          <p className="font-body text-xs text-noir-ash truncate">
            {track.artist}
            {track.album && <span className="text-noir-dim"> · {track.album}</span>}
          </p>

          <p className="font-mono text-[10px] text-noir-dim mt-0.5">
            {formatDuration(track.duration)}
          </p>
        </div>
      </div>

      {/* Right: Actions based STRICTLY on server capabilities */}
      <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
        {/* Playable via NoirSync Stream */}
        {capabilities.playback === 'noirsync_stream' && onPlay && (
          <Button
            variant="gold"
            size="sm"
            onClick={() => onPlay(track)}
            className="flex items-center gap-1.5 text-xs text-accent-gold"
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </Button>
        )}

        {/* External Link */}
        {capabilities.playback === 'external_link' && track.externalUrl && (
          <a
            href={track.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-lg font-mono text-[11px] font-semibold uppercase tracking-wider bg-noir-graphite hover:bg-noir-border/40 border border-noir-border/60 text-noir-ash hover:text-noir-white transition-all flex items-center gap-1.5"
          >
            <span>↗</span>
            <span>Open in {badge.label}</span>
          </a>
        )}

        {/* Embedded Player Link / Trigger */}
        {capabilities.playback === 'embedded_player' && track.externalUrl && (
          <a
            href={track.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-lg font-mono text-[11px] font-semibold uppercase tracking-wider bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 hover:text-red-300 transition-all flex items-center gap-1.5"
          >
            <span>▶</span>
            <span>Watch on YouTube</span>
          </a>
        )}

        {/* Download Button (ONLY rendered when server capability download is true) */}
        {capabilities.download && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDownload}
            className="flex items-center gap-1 text-xs text-noir-ash hover:text-accent-gold"
            title="Download audio"
          >
            <span>⬇</span>
            <span>Download</span>
          </Button>
        )}

        {/* Add to Playlist (Always available for universal tracks) */}
        {capabilities.addToPlaylist && (
          <Button
            variant="default"
            size="sm"
            onClick={() => onAddToPlaylist(track)}
            className="flex items-center gap-1 text-xs"
          >
            <span>➕</span>
            <span>Playlist</span>
          </Button>
        )}
      </div>
    </div>
  );
}
