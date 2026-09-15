import { useState, useRef } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RoomLobby }     from './components/RoomLobby';
import { HostView }      from './components/HostView';
import { ViewerView }    from './components/ViewerView';
import { useNtpSync }    from './hooks/useNtpSync';
import { usePlayback }   from './hooks/usePlayback';
import { Spinner }       from './components/ui/Spinner';
import { disconnectSocket } from './lib/socket';

type Role = 'host' | 'viewer' | null;

interface Session {
  role: Role;
  roomId: string;
  displayName: string;
}

export default function App() {
  const { synced } = useNtpSync();
  const audioRef = useRef<HTMLAudioElement>(null);
  const adapter = usePlayback(audioRef);

  const [session, setSession] = useState<Session>({
    role: null,
    roomId: '',
    displayName: '',
  });

  const handleJoin = (role: 'host' | 'viewer', roomId: string, displayName: string) => {
    // Unlock the audio element right here inside the click handler!
    const audio = audioRef.current;
    if (audio) {
      // Play a tiny silence to unlock
      const silentSrc = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAAA';
      audio.src = silentSrc;
      audio.play().then(() => {
        audio.pause();
        console.info('[App] Audio element successfully unlocked via lobby interaction');
      }).catch((err) => {
        console.warn('[App] Failed to unlock audio element:', err);
      });
    }

    setSession({ role, roomId, displayName });
    // Update URL for shareable state (viewer link)
    if (role === 'viewer') {
      const url = new URL(window.location.href);
      url.searchParams.set('room', roomId);
      window.history.replaceState({}, '', url.toString());
    }
  };

  const handleLeave = () => {
    disconnectSocket();
    setSession({ role: null, roomId: '', displayName: '' });
    // Clear url query param if present
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
  };

  // ── NTP clock sync loading screen ─────────────────────────────────────
  if (!synced) {
    return (
      <div className="min-h-screen bg-noir-black flex flex-col items-center justify-center gap-6">
        <Spinner size="lg" />
        <div className="text-center space-y-2">
          <p className="font-mono text-xs text-noir-ash tracking-[0.3em] uppercase animate-pulse">
            Synchronizing Clock
          </p>
          <p className="font-mono text-[10px] text-noir-dim/60">
            calibrating NTP offset…
          </p>
        </div>
      </div>
    );
  }

  // Warn if NTP sync had an error but still let the user proceed
  // (offset defaults to 0, so sync is best-effort)

  return (
    <ErrorBoundary>
      {!session.role && (
        <RoomLobby onJoin={handleJoin} />
      )}

      {session.role === 'host' && (
        <ErrorBoundary>
          <HostView roomId={session.roomId} displayName={session.displayName} onLeave={handleLeave} adapter={adapter} />
        </ErrorBoundary>
      )}

      {session.role === 'viewer' && (
        <ErrorBoundary>
          <ViewerView roomId={session.roomId} displayName={session.displayName} onLeave={handleLeave} adapter={adapter} />
        </ErrorBoundary>
      )}
      <audio ref={audioRef} preload="auto" className="hidden" aria-hidden="true" />
    </ErrorBoundary>
  );
}
