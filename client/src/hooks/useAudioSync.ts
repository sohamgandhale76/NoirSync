import { useCallback, useEffect, useRef } from 'react';
import { getServerTime } from '../lib/ntp';
import { PlaybackAdapter } from '../lib/playback/PlaybackAdapter';

/**
 * Schedules audio.play() at exactly `scheduledStartTime` (server clock),
 * compensating for the NTP offset and minor scheduling drift.
 *
 * Uses requestAnimationFrame for sub-16ms precision when close to start time,
 * and setTimeout for coarser scheduling when far away.
 */
export function useAudioSync(
  adapter: PlaybackAdapter | null,
  scheduledStartTime: number | null,
  currentTime: number,
  isPlaying: boolean,
) {
  const rafRef     = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unbindMetadataRef = useRef<(() => void) | null>(null);

  const cancelAll = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (unbindMetadataRef.current !== null) {
      unbindMetadataRef.current();
      unbindMetadataRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!adapter) return;

    if (!isPlaying) {
      cancelAll();
      adapter.pause();
      return;
    }

    if (scheduledStartTime === null) return;

    // Pre-position the audio head if metadata is loaded
    const safeCurrentTime = Math.max(0, currentTime);
    if (adapter.isReady()) {
      if (Math.abs(adapter.getCurrentTime() - safeCurrentTime) > 0.5) {
        adapter.seekTo(safeCurrentTime);
      }
    }

    const tryPlay = () => {
      if (unbindMetadataRef.current !== null) {
        unbindMetadataRef.current();
        unbindMetadataRef.current = null;
      }

      // If metadata isn't loaded yet, we must wait for it to seek and play properly
      if (!adapter.isReady()) {
        const onLoadedMetadata = () => {
          unbindMetadataRef.current = null;
          tryPlay();
        };
        unbindMetadataRef.current = adapter.on('loadedmetadata', onLoadedMetadata);
        return;
      }

      const now = getServerTime();
      const msUntil = scheduledStartTime - now;

      if (msUntil <= 0) {
        // We're at or past scheduled time — apply drift compensation
        const driftSecs = Math.abs(msUntil) / 1000;
        const target = safeCurrentTime + driftSecs;
        if (Math.abs(adapter.getCurrentTime() - target) > 0.1) {
          adapter.seekTo(target);
        }
        adapter.play().catch((err: Error) => {
          // Autoplay blocked by browser — user interaction required
          if (err.name !== 'AbortError') {
            console.warn('[audioSync] play() rejected:', err.message);
          }
        });
        return;
      }

      if (msUntil > 500) {
        // Far away — use setTimeout, check again when closer
        timeoutRef.current = setTimeout(() => {
          rafRef.current = requestAnimationFrame(tryPlay);
        }, msUntil - 500);
      } else {
        // Close — use rAF for frame-accurate scheduling
        rafRef.current = requestAnimationFrame(tryPlay);
      }
    };

    tryPlay();
    return cancelAll;
  }, [scheduledStartTime, isPlaying, currentTime, adapter, cancelAll]);
}
