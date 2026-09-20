import { useState, useCallback, useEffect } from 'react';
import { GlassPanel } from './ui/GlassPanel';
import { Button } from './ui/Button';
import { GlowSpotlight } from './GlowSpotlight';
import { useAuth } from '../hooks/useAuth';
import { AccountBadge } from './AccountBadge';

interface Props {
  onJoin: (role: 'host' | 'viewer', roomId: string, displayName: string) => void;
}

function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function RoomLobby({ onJoin }: Props) {
  const { user, isAuthenticated, login, register, logout } = useAuth();
  const [name, setName]       = useState('');
  const [roomId, setRoomId]   = useState('');
  const [mode, setMode]       = useState<'host' | 'viewer'>('host');
  const [roomIdError, setRoomIdError] = useState('');

  // Pre-fill display name when user logs in
  useEffect(() => {
    if (user?.displayName || user?.username) {
      setName(user.displayName || user.username || '');
    }
  }, [user]);

  // Pre-fill room ID from URL param (for shared invite links)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomId(roomParam.toUpperCase());
      setMode('viewer');
    }
  }, []);

  const handleCreate = useCallback(() => {
    const id = generateRoomId();
    onJoin('host', id, name.trim() || 'Host');
  }, [name, onJoin]);

  const handleJoin = useCallback(() => {
    const trimmed = roomId.trim().toUpperCase();
    if (!trimmed) {
      setRoomIdError('Please enter a room code.');
      return;
    }
    if (!/^[A-Z0-9]{4,16}$/.test(trimmed)) {
      setRoomIdError('Room code must be 4–16 letters/numbers.');
      return;
    }
    setRoomIdError('');
    onJoin('viewer', trimmed, name.trim() || 'Listener');
  }, [roomId, name, onJoin]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (mode === 'host') handleCreate();
      else handleJoin();
    }
  };

  return (
    <div
      className="relative min-h-screen bg-noir-black flex flex-col items-center justify-center px-6 py-12 grain-overlay overflow-hidden"
      onKeyDown={handleKeyDown}
    >
      <GlowSpotlight />

      {/* Top right account badge */}
      <div className="absolute top-6 right-6 z-30 animate-fade-in">
        <AccountBadge
          user={user}
          isAuthenticated={isAuthenticated}
          onLogin={login}
          onRegister={register}
          onLogout={logout}
        />
      </div>

      {/* Background decorative text */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none select-none overflow-hidden"
        aria-hidden="true"
      >
        <span
          className="font-display text-[22vw] font-bold text-noir-charcoal/30 leading-none tracking-tighter"
          style={{ letterSpacing: '-0.05em' }}
        >
          NOIR
        </span>
      </div>

      {/* Cinematic header */}
      <div className="relative mb-10 text-center z-10 animate-fade-in">
        <p className="font-mono text-[10px] tracking-[0.4em] text-noir-dim uppercase mb-4">
          ✦ synchronized listening ✦
        </p>
        <h1 className="font-display text-7xl font-bold tracking-tight leading-none">
          <span className="text-noir-white">Noir</span>
          <span className="text-gold-gradient">Sync</span>
        </h1>
        <p className="font-body text-noir-ash text-lg mt-3 tracking-wider">
          dark by design · precise by obsession
        </p>
      </div>

      {/* Main card */}
      <GlassPanel className="relative w-full max-w-md p-8 space-y-6 z-10 animate-slide-up">
        {/* Display name */}
        <div>
          <label htmlFor="display-name" className="block font-mono text-[10px] tracking-[0.25em] text-noir-ash uppercase mb-2">
            Your Name
          </label>
          <input
            id="display-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Anonymous"
            maxLength={32}
            autoComplete="nickname"
            className="w-full bg-noir-graphite border border-noir-border text-noir-white px-4 py-3 rounded-lg font-ui text-sm focus:outline-none focus:border-accent-gold/60 focus:ring-2 focus:ring-accent-gold/20 transition-all placeholder:text-noir-dim"
          />
        </div>

        {/* Mode selector */}
        <div
          role="tablist"
          aria-label="Room mode"
          className="flex rounded-lg overflow-hidden border border-noir-border bg-noir-graphite"
        >
          {(['host', 'viewer'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              id={`tab-${m}`}
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`flex-1 py-3 font-mono text-[11px] tracking-[0.2em] uppercase transition-all ${
                mode === m
                  ? 'bg-accent-gold text-noir-black font-bold'
                  : 'text-noir-ash hover:text-noir-white'
              }`}
            >
              {m === 'host' ? '🎙 Create Room' : '🎧 Join Room'}
            </button>
          ))}
        </div>

        {/* Action area */}
        {mode === 'host' ? (
          <Button
            id="create-room-btn"
            variant="gold"
            size="lg"
            className="w-full"
            onClick={handleCreate}
          >
            Create a Room
          </Button>
        ) : (
          <div className="space-y-3">
            <div>
              <input
                id="room-code-input"
                type="text"
                value={roomId}
                onChange={(e) => {
                  setRoomId(e.target.value.toUpperCase());
                  setRoomIdError('');
                }}
                placeholder="AB12CD"
                maxLength={16}
                aria-label="Room code"
                aria-describedby={roomIdError ? 'room-code-error' : undefined}
                className={`w-full bg-noir-graphite border text-noir-white px-4 py-3 rounded-lg font-mono text-lg tracking-[0.25em] text-center uppercase focus:outline-none focus:ring-2 transition-all placeholder:text-noir-dim placeholder:tracking-widest ${
                  roomIdError
                    ? 'border-red-700 focus:border-red-600 focus:ring-red-900/30'
                    : 'border-noir-border focus:border-accent-gold/60 focus:ring-accent-gold/20'
                }`}
              />
              {roomIdError && (
                <p id="room-code-error" role="alert" className="mt-1.5 text-xs text-red-400 font-ui">
                  {roomIdError}
                </p>
              )}
            </div>
            <Button
              id="join-room-btn"
              variant="gold"
              size="lg"
              className="w-full"
              onClick={handleJoin}
            >
              Join the Room
            </Button>
          </div>
        )}

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-noir-border" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-noir-charcoal px-3 text-[10px] font-mono text-noir-dim tracking-widest">
              HOW IT WORKS
            </span>
          </div>
        </div>

        {/* Feature pills */}
        <div className="flex flex-wrap gap-2 justify-center">
          {['NTP clock sync', '5s chunk streaming', 'Live lyrics', 'PWA ready'].map((feat) => (
            <span
              key={feat}
              className="px-3 py-1 rounded-full border border-noir-border text-[11px] font-mono text-noir-dim tracking-wide"
            >
              {feat}
            </span>
          ))}
        </div>
      </GlassPanel>

      <p className="relative mt-8 text-noir-dim/50 text-xs font-mono z-10">
        open source · zero data collected · runs on your network
      </p>
    </div>
  );
}
