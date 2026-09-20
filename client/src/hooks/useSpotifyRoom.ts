import { useEffect, useRef, useState, useCallback } from 'react';
import { useSpotifyPlayback } from './useSpotifyPlayback';
import { RoomState, SpotifyListenerInfo } from './useRoom';

interface UseSpotifyRoomProps {
  roomState: RoomState;
  role: 'host' | 'viewer';
  roomJoined?: boolean;
  emitListenerStatus?: (status: Partial<SpotifyListenerInfo>) => void;
}

export function useSpotifyRoom({
  roomState,
  role,
  roomJoined,
  emitListenerStatus,
}: UseSpotifyRoomProps) {
  const {
    isSpotifyConnected,
    spotifyAccount,
    loading: authLoading,
    error: spotifyError,
    connectSpotify,
    adapter,
  } = useSpotifyPlayback();

  const [isReady, setIsReady] = useState(false);
  const [inSync, setInSync] = useState(false);
  const [isPremium, setIsPremium] = useState(true);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('Initializing');

  const lastTrackUriRef = useRef<string | null>(null);
  const isSyncingRef = useRef<boolean>(false);

  // Check adapter readiness and subscribe to adapter events
  useEffect(() => {
    const handleCanPlay = () => {
      console.info('[SpotifyRoom] Adapter canplay event -> setting isReady=true');
      setIsReady(true);
      setStatusMessage('Spotify Ready');
    };

    const handleWaiting = (err?: any) => {
      console.warn('[SpotifyRoom] Adapter waiting event received with error:', err?.message);
      if (err?.message?.includes('Premium') || err?.message?.includes('403')) {
        console.warn('[SpotifyRoom] Computed NoirSync isPremium transitioning to false. Reason:', err?.message);
        setIsPremium(false);
        setStatusMessage('Premium Required');
      }
    };

    const handlePlay = () => {
      console.info('[SpotifyRoom] Adapter play event -> setting inSync=true');
      setInSync(true);
      setPlaybackBlocked(false);
    };

    const handlePause = () => {
      if (!roomState.isPlaying) {
        setInSync(true);
      }
    };

    const unsubCanPlay = adapter.on('canplay', handleCanPlay);
    const unsubWaiting = adapter.on('waiting', handleWaiting);
    const unsubPlay = adapter.on('play', handlePlay);
    const unsubPause = adapter.on('pause', handlePause);

    if (adapter.isReady()) {
      console.info('[SpotifyRoom] Adapter isReady() is true immediately upon subscription');
      setIsReady(true);
      setStatusMessage('Spotify Ready');
    }

    return () => {
      unsubCanPlay();
      unsubWaiting();
      unsubPlay();
      unsubPause();
    };
  }, [adapter, roomState.isPlaying]);

  // Report status to room whenever room membership is confirmed or status changes
  useEffect(() => {
    if (!roomJoined || !emitListenerStatus) return;

    let status = 'not_connected';
    if (!isSpotifyConnected) {
      status = 'unlinked';
    } else if (!isPremium) {
      status = 'non_premium';
    } else if (playbackBlocked) {
      status = 'gesture_blocked';
    } else if (inSync) {
      status = 'in_sync';
    } else if (isReady) {
      status = 'ready';
    } else {
      status = 'syncing';
    }

    const payload = {
      isConnected: isSpotifyConnected,
      isPremium,
      isReady,
      inSync,
      status,
    };

    console.info('[SpotifyRoom] emitting listener status');
    console.info('[SpotifyRoom] listener status payload', payload);
    emitListenerStatus(payload);
  }, [emitListenerStatus, roomJoined, isSpotifyConnected, isPremium, isReady, inSync, playbackBlocked, roomState.source, roomState.spotifyTrack?.id]);

  // Handle Room State synchronization for Spotify tracks
  // CRITICAL: Synchronizes ONLY on discrete state changes (source, URI, play/pause, scheduledStartTime, timestamp)
  // Continuous roomState.currentTime updates are decoupled and do NOT trigger synchronization commands.
  useEffect(() => {
    // If room is NOT in Spotify mode, ensure local Spotify playback is stopped
    if (roomState.source !== 'spotify') {
      if (lastTrackUriRef.current) {
        adapter.pause();
        lastTrackUriRef.current = null;
      }
      setInSync(false);
      return;
    }

    const spotifyTrack = roomState.spotifyTrack;
    if (!spotifyTrack || !spotifyTrack.uri) return;

    // Set track on adapter if changed
    if (lastTrackUriRef.current !== spotifyTrack.uri) {
      adapter.setSrc(spotifyTrack.uri);
      lastTrackUriRef.current = spotifyTrack.uri;
    }

    // Viewers: Automatically synchronize with room state on discrete events
    if (role === 'viewer') {
      if (!isSpotifyConnected) {
        setStatusMessage('Spotify account not linked');
        return;
      }

      const syncPlayback = async () => {
        if (isSyncingRef.current) return;
        isSyncingRef.current = true;

        try {
          if (roomState.isPlaying) {
            const now = Date.now();
            const startTime = roomState.scheduledStartTime || roomState.spotifyState?.timestamp || now;
            const msUntilStart = startTime - now;

            if (msUntilStart > 0 && msUntilStart <= 500) {
              await new Promise(resolve => setTimeout(resolve, msUntilStart));
            }

            const playNow = Date.now();
            const delaySecs = (playNow - startTime) / 1000;
            const targetSecs = Math.max(0, roomState.currentTime + (delaySecs > 0 ? delaySecs : 0));
            const targetMs = targetSecs * 1000;

            await adapter.play(targetMs);
            setInSync(true);
            setPlaybackBlocked(false);
            setStatusMessage('Playing in sync');
          } else {
            adapter.pause();
            if (typeof roomState.currentTime === 'number' && roomState.currentTime >= 0) {
              adapter.seekTo(roomState.currentTime);
            }
            setInSync(true);
            setStatusMessage('Paused');
          }
        } catch (err: any) {
          console.warn('[SpotifyRoom] Sync playback error:', err);
          if (err?.message?.includes('Premium') || err?.message?.includes('403')) {
            setIsPremium(false);
            setStatusMessage('Spotify Premium required');
          } else {
            setPlaybackBlocked(true);
            setStatusMessage('Audio gesture required');
          }
          setInSync(false);
        } finally {
          isSyncingRef.current = false;
        }
      };

      syncPlayback();
    }
  }, [
    roomState.source,
    roomState.spotifyTrack?.uri,
    roomState.isPlaying,
    roomState.scheduledStartTime,
    roomState.spotifyState?.timestamp,
    role,
    isSpotifyConnected,
    adapter
  ]);

  // Drift correction loop (runs every 3 seconds during active playback)
  useEffect(() => {
    if (roomState.source !== 'spotify' || !roomState.isPlaying || role !== 'viewer' || !isSpotifyConnected) {
      return;
    }

    const interval = setInterval(() => {
      const now = Date.now();
      const startTime = roomState.scheduledStartTime || roomState.spotifyState?.timestamp || now;
      const elapsedSinceUpdate = Math.max(0, (now - startTime) / 1000);
      const expectedTime = roomState.currentTime + elapsedSinceUpdate;
      const actualTime = adapter.getCurrentTime();

      const drift = Math.abs(expectedTime - actualTime);
      if (drift > 2.0 && actualTime > 0) {
        console.info(`[SpotifyRoom] Correcting drift (${drift.toFixed(2)}s). Resyncing to ${expectedTime.toFixed(1)}s`);
        adapter.seekTo(expectedTime);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [roomState.source, roomState.isPlaying, roomState.currentTime, roomState.scheduledStartTime, roomState.spotifyState?.timestamp, role, isSpotifyConnected, adapter]);

  // Manual gesture unlock & sync trigger (e.g. user clicks "Sync Audio")
  const syncAudio = useCallback(async () => {
    try {
      await adapter.activateElement();
      if (roomState.spotifyTrack?.uri) {
        adapter.setSrc(roomState.spotifyTrack.uri);
      }
      const now = Date.now();
      const startTime = roomState.scheduledStartTime || roomState.spotifyState?.timestamp || now;
      const delaySecs = (now - startTime) / 1000;
      const targetSecs = Math.max(0, roomState.currentTime + (delaySecs > 0 ? delaySecs : 0));

      if (roomState.isPlaying) {
        await adapter.play(targetSecs * 1000);
      } else {
        adapter.pause();
        adapter.seekTo(roomState.currentTime);
      }
      setPlaybackBlocked(false);
      setInSync(true);
    } catch (err: any) {
      console.warn('[SpotifyRoom] Manual sync failed:', err);
      if (err?.message?.includes('Premium') || err?.message?.includes('403')) {
        setIsPremium(false);
      } else {
        setPlaybackBlocked(true);
      }
    }
  }, [adapter, roomState.spotifyTrack?.uri, roomState.currentTime, roomState.isPlaying, roomState.scheduledStartTime, roomState.spotifyState?.timestamp]);

  return {
    isSpotifyConnected,
    spotifyAccount,
    authLoading,
    spotifyError,
    connectSpotify,
    adapter,
    isReady,
    inSync,
    isPremium,
    playbackBlocked,
    statusMessage,
    syncAudio,
  };
}
