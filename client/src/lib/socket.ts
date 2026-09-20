// ─── Socket.io Singleton ──────────────────────────────────────────────────
// One socket instance per tab; reconnects automatically on disconnect.

import { io, type Socket } from 'socket.io-client';
import { SERVER_URL } from './constants';

let _socket: Socket | null = null;

export function getSocket(): Socket {
  if (!_socket) {
    _socket = io(SERVER_URL || window.location.origin, {
      path: '/socket.io',
      transports: ['websocket', 'polling'], // websocket preferred, polling fallback
      autoConnect: false,
      reconnection: true,
      withCredentials: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 5_000,
      timeout: 10_000,
    });

    _socket.on('connect_error', (err) => {
      console.warn('[socket] connection error:', err.message);
    });

    _socket.on('reconnect', (attempt) => {
      console.info(`[socket] reconnected after ${attempt} attempt(s)`);
    });
  }
  return _socket;
}

export function connectSocket(): Socket {
  const s = getSocket();
  if (!s.connected) s.connect();
  return s;
}

export function disconnectSocket() {
  _socket?.disconnect();
  _socket = null;
}
