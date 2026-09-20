// ─── Sliding Window Buffer Architecture ───────────────────────────────────
//
// Memory model:
//   chunks[N] = { buffer: Buffer, mimeType: string, uploadedAt: number }
//
// GC rule: delete all chunks where index < (currentPlayingChunk - KEEP_PAST)
//   This keeps ~15s behind + ~30s ahead = ≈45s max in RAM per room
//
// Room TTL: rooms with no activity for ROOM_TTL_MS are auto-expired.

const logger = require('./logger');

const KEEP_PAST_CHUNKS   = 3;  // chunks behind current (≈15 s at 5 s/chunk)
const KEEP_FUTURE_CHUNKS = 6;  // chunks ahead of current (≈30 s prefetch)
const ROOM_TTL_MS = parseInt(process.env.ROOM_TTL_MS || '7200000', 10); // 2 hours

// ─── Room ─────────────────────────────────────────────────────────────────
class Room {
  constructor(roomId) {
    this.roomId   = roomId;
    this.hostUserId = null;   // Server-authoritative host user ID
    this.hostSocketId = null; // Host transport socket ID (bookkeeping only)
    this.userIds  = new Set(); // Set<userId: string> - active room members
    this.chunks   = new Map(); // Map<chunkIndex: number, ChunkEntry>
    this.members  = new Map(); // Map<socketId: string, MemberInfo>
    this.spotifyListeners = new Map(); // Map<socketId: string, SpotifyListenerInfo>
    this.maxBufferedBytes = parseInt(process.env.MAX_ROOM_BUFFERED_MB || '100', 10) * 1024 * 1024; // 100MB default
    this.state    = {
      isPlaying: false,
      currentTime: 0,
      chunkIndex: 0,
      scheduledStartTime: null,
      mimeType: 'audio/mpeg',
      totalChunks: null,
      songName: '',
      libraryTrackId: null, // Track ID if playing from catalog
      coverFilename: null,
      coverUrl: null,       // Direct image URL for Spotify or external providers
      duration: 0,
      durationMs: 0,
      lyrics: [],
      lrcMeta: {},
      queue: [],
      currentQueueIndex: -1,
      source: 'local',      // 'local' | 'spotify'
      spotifyTrack: null,
      spotifyState: null,
    };
    this.libraryFileBuffer = null;
    this.bytesPerChunk     = null;
    this.telegramFileIds   = null;
    this.createdAt   = Date.now();
    this.lastActivity = Date.now();
  }

  // ── Host & Membership Authority ──

  setHost(userId, socketId) {
    this.hostUserId = userId || null;
    this.hostSocketId = socketId || null;
  }

  /**
   * Authoritative host check based strictly on authenticated user identity.
   * Transport socketId does NOT independently grant host authority.
   */
  isHost(userId) {
    return Boolean(userId && this.hostUserId && userId === this.hostUserId);
  }

  /**
   * Authoritative membership check based strictly on authenticated user identity.
   * Transport socketId does NOT independently grant room membership.
   */
  isMember(userId) {
    return Boolean(userId && this.userIds.has(userId));
  }

  // ── Chunk management ──

  setLibraryTrack(track, fileBuffer) {
    this.libraryFileBuffer = fileBuffer;
    this.telegramFileIds = null;
    this.state.source = 'local';
    this.state.spotifyTrack = null;
    this.state.spotifyState = null;
    this.state.coverUrl = null;
    this.state.libraryTrackId = track.id;
    this.state.mimeType = track.mimeType;
    this.state.songName = track.title;
    this.state.coverFilename = track.coverFilename || null;
    this.state.duration = track.duration || 0;
    this.state.durationMs = (track.duration || 0) * 1000;
    
    // Calculate total chunks (5s per chunk)
    const CHUNK_DURATION = 5;
    const totalChunks = Math.ceil(track.duration / CHUNK_DURATION);
    this.state.totalChunks = totalChunks;
    
    // Calculate byte size per chunk
    this.bytesPerChunk = Math.ceil(fileBuffer.length / totalChunks);
    
    this.touch();
    logger.info('Room loaded track from library', {
      roomId: this.roomId,
      trackId: track.id,
      title: track.title,
      totalChunks,
      fileSize: fileBuffer.length
    });
  }

  setTelegramLibraryTrack(track) {
    this.libraryFileBuffer = null;
    this.bytesPerChunk = null;
    this.telegramFileIds = track.fileIds;
    this.state.source = 'local';
    this.state.spotifyTrack = null;
    this.state.spotifyState = null;
    this.state.coverUrl = null;
    this.state.libraryTrackId = track.id;
    this.state.mimeType = track.mimeType;
    this.state.songName = track.title;
    this.state.coverFilename = track.coverFilename || null;
    this.state.totalChunks = track.fileIds.length;
    this.state.duration = track.duration || 0;
    this.state.durationMs = (track.duration || 0) * 1000;
    
    this.touch();
    logger.info('Room loaded Telegram track from library', {
      roomId: this.roomId,
      trackId: track.id,
      title: track.title,
      totalChunks: track.fileIds.length
    });
  }

  setSpotifyTrack(track) {
    this.libraryFileBuffer = null;
    this.telegramFileIds = null;
    this.bytesPerChunk = null;
    this.chunks.clear();

    const durationSecs = Number(track.duration) || (track.durationMs ? Math.round(track.durationMs / 1000) : 0);
    const durationMs = Number(track.durationMs) || (durationSecs * 1000);

    this.state.source = 'spotify';
    this.state.songName = track.title || '';
    this.state.libraryTrackId = null;
    this.state.coverFilename = null;
    this.state.coverUrl = track.coverUrl || null;
    this.state.totalChunks = null;
    this.state.duration = durationSecs;
    this.state.durationMs = durationMs;
    this.state.isPlaying = false;
    this.state.currentTime = 0;
    this.state.chunkIndex = 0;
    this.state.scheduledStartTime = null;
    this.state.spotifyTrack = {
      id: track.id,
      uri: track.uri || `spotify:track:${track.id}`,
      title: track.title,
      artist: track.artist || '',
      album: track.album || '',
      coverUrl: track.coverUrl || null,
      duration: durationSecs,
      durationMs: durationMs,
    };
    this.state.spotifyState = {
      isPlaying: false,
      positionMs: 0,
      timestamp: Date.now()
    };
    this.state.lrcMeta = {
      title: track.title,
      artist: track.artist || '',
      album: track.album || ''
    };
    this.state.lyrics = track.lyrics || [];
    this.touch();
    logger.info('Room loaded Spotify track', {
      roomId: this.roomId,
      trackId: track.id,
      title: track.title,
      artist: track.artist
    });
  }

  updateSpotifyListener(socketId, info) {
    const member = this.members.get(socketId);
    this.spotifyListeners.set(socketId, {
      socketId,
      userId: member?.userId || info.userId || null,
      displayName: member?.displayName || info.displayName || 'Listener',
      isConnected: Boolean(info.isConnected),
      isPremium: Boolean(info.isPremium),
      isReady: Boolean(info.isReady),
      inSync: Boolean(info.inSync),
      status: info.status || (info.inSync ? 'in_sync' : info.isReady ? 'ready' : 'not_connected'),
      updatedAt: Date.now()
    });
    this.touch();
  }

  async getTelegramChunk(index) {
    if (this.chunks.has(index)) {
      return this.chunks.get(index);
    }

    if (!this.telegramFileIds || index >= this.telegramFileIds.length) {
      return null;
    }

    const fileId = this.telegramFileIds[index];
    const telegramBot = require('./telegramBot');
    
    logger.debug('Fetching chunk from Telegram CDN', { room: this.roomId, index });
    const buffer = await telegramBot.getChunkBuffer(fileId);
    
    const entry = {
      buffer,
      mimeType: this.state.mimeType,
      uploadedAt: Date.now(),
      size: buffer.length
    };
    
    this.chunks.set(index, entry);
    return entry;
  }

  /**
   * INVARIANT: Temporary room uploads are strictly in-memory chunks.
   * They must NEVER create database records in `tracks`, never touch R2,
   * and never be added to persistent Cloud Library catalogs.
   */
  addChunk(index, buffer, mimeType) {
    const chunkSize = buffer ? buffer.length : 0;
    const existingSize = this.chunks.has(index) ? this.chunks.get(index).size : 0;
    const currentBytes = this.totalBufferedBytes();

    // Check memory limit BEFORE storing chunk in memory
    if ((currentBytes - existingSize + chunkSize) > this.maxBufferedBytes) {
      const limitMB = Math.round(this.maxBufferedBytes / (1024 * 1024));
      const err = new Error(`Room buffered memory limit (${limitMB}MB) exceeded`);
      err.status = 413;
      throw err;
    }

    this.chunks.set(index, {
      buffer,
      mimeType: mimeType || this.state.mimeType,
      uploadedAt: Date.now(),
      size: chunkSize,
    });
    if (mimeType) this.state.mimeType = mimeType;
    this.touch();

    logger.debug('Chunk stored', {
      room: this.roomId,
      chunkIndex: index,
      sizeKB: (chunkSize / 1024).toFixed(1),
      totalChunks: this.chunks.size,
    });
  }

  getChunk(index) {
    // If backed by library file buffer, slice dynamically
    if (this.libraryFileBuffer && this.bytesPerChunk) {
      const start = index * this.bytesPerChunk;
      if (start >= this.libraryFileBuffer.length) return null;
      
      const end = Math.min(start + this.bytesPerChunk, this.libraryFileBuffer.length);
      const slice = this.libraryFileBuffer.subarray(start, end);
      return {
        buffer: slice,
        mimeType: this.state.mimeType,
        uploadedAt: Date.now(),
        size: slice.length
      };
    }
    return this.chunks.get(index) || null;
  }

  /**
   * Garbage-collect chunks older than KEEP_PAST_CHUNKS behind current.
   * Also drops chunks far ahead (> current + KEEP_FUTURE_CHUNKS) on seek.
   */
  gcOldChunks(currentChunkIndex) {
    const lowerBound = currentChunkIndex - KEEP_PAST_CHUNKS;
    let freed = 0;
    for (const [idx] of this.chunks) {
      if (idx < lowerBound) {
        this.chunks.delete(idx);
        freed++;
      }
    }
    if (freed > 0) {
      logger.debug('GC freed chunks', { room: this.roomId, freed, remaining: this.chunks.size });
    }
  }

  getAvailableChunkIndices() {
    return Array.from(this.chunks.keys()).sort((a, b) => a - b);
  }

  /** Total bytes currently buffered in this room */
  totalBufferedBytes() {
    let total = 0;
    for (const [, entry] of this.chunks) total += entry.size;
    return total;
  }

  // ── Member management ──

  addMember(socketId, info) {
    this.members.set(socketId, { ...info, joinedAt: Date.now() });
    if (info && info.userId) {
      this.userIds.add(info.userId);
    }
    this.touch();
  }

  removeMember(socketId) {
    const member = this.members.get(socketId);
    this.members.delete(socketId);
    this.spotifyListeners.delete(socketId);

    if (member && member.userId) {
      // Only remove userId if no other sockets remain for this user
      let stillPresent = false;
      for (const m of this.members.values()) {
        if (m.userId === member.userId) {
          stillPresent = true;
          break;
        }
      }
      if (!stillPresent) {
        this.userIds.delete(member.userId);
      }
    }

    if (this.hostSocketId === socketId) {
      let remainingHostSocket = null;
      if (this.hostUserId) {
        for (const [sid, m] of this.members.entries()) {
          if (m.userId === this.hostUserId) {
            remainingHostSocket = sid;
            break;
          }
        }
      }
      this.hostSocketId = remainingHostSocket;
    }
    this.touch();
  }

  getMemberCount() {
    return this.members.size;
  }

  getMembersArray() {
    return Array.from(this.members.entries()).map(([id, info]) => ({ id, ...info }));
  }

  // ── State ──

  setState(partial) {
    Object.assign(this.state, partial);
    this.touch();
  }

  getState() {
    return {
      ...this.state,
      chunkCount: this.chunks.size,
      availableChunks: this.getAvailableChunkIndices(),
      memberCount: this.getMemberCount(),
      members: this.getMembersArray(),
      spotifyListeners: Array.from(this.spotifyListeners.values()),
    };
  }

  // ── Lifecycle & TTL ──

  destroy() {
    this.chunks.clear();
    this.members.clear();
    this.spotifyListeners.clear();
    this.userIds.clear();
    this.libraryFileBuffer = null;
    this.telegramFileIds = null;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  isExpired() {
    return Date.now() - this.lastActivity > ROOM_TTL_MS;
  }
}

// ─── RoomManager ──────────────────────────────────────────────────────────
class RoomManager {
  constructor() {
    this.rooms       = new Map(); // Map<roomId, Room>
    this.memberIndex = new Map(); // Map<socketId, roomId> for O(1) disconnect lookup

    // TTL sweep: check every 5 minutes, remove expired rooms
    this._gcInterval = setInterval(() => this._sweepExpiredRooms(), 5 * 60 * 1000);
    logger.info('RoomManager initialised', { ttlMs: ROOM_TTL_MS });
  }

  createRoom(roomId, hostUserId = null, hostSocketId = null) {
    const room = new Room(roomId);
    if (hostUserId) {
      room.setHost(hostUserId, hostSocketId);
    }
    this.rooms.set(roomId, room);
    logger.info('Room created', { roomId, hostUserId });
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  addMemberToRoom(roomId, socketId, info) {
    const room = this.getRoom(roomId);
    if (room) {
      room.addMember(socketId, info);
      this.memberIndex.set(socketId, roomId);
    }
  }

  removeMember(socketId) {
    const roomId = this.memberIndex.get(socketId);
    if (!roomId) return null;

    const room = this.getRoom(roomId);
    if (room) {
      room.removeMember(socketId);
      if (room.getMemberCount() === 0) {
        room.destroy();
        this.rooms.delete(roomId);
        logger.info('Room deleted (empty)', { roomId });
      }
    }
    this.memberIndex.delete(socketId);
    return roomId;
  }

  getRoomStats() {
    const stats = [];
    for (const [id, room] of this.rooms) {
      stats.push({
        roomId: id,
        members: room.getMemberCount(),
        chunks: room.chunks.size,
        bufferedMB: (room.totalBufferedBytes() / 1024 / 1024).toFixed(2),
        ageMinutes: ((Date.now() - room.createdAt) / 60_000).toFixed(1),
      });
    }
    return stats;
  }

  /** Remove rooms that have exceeded ROOM_TTL_MS with no activity */
  _sweepExpiredRooms() {
    let swept = 0;
    for (const [id, room] of this.rooms) {
      if (room.isExpired()) {
        room.destroy();
        this.rooms.delete(id);
        // Clean up member index entries for this room
        for (const [sid, rid] of this.memberIndex) {
          if (rid === id) this.memberIndex.delete(sid);
        }
        swept++;
        logger.info('Room expired (TTL)', { roomId: id });
      }
    }
    if (swept > 0) logger.info(`TTL sweep removed ${swept} room(s)`);
  }

  /** Call on process exit to clean up the interval */
  destroy() {
    clearInterval(this._gcInterval);
    for (const room of this.rooms.values()) {
      room.destroy();
    }
    this.rooms.clear();
    this.memberIndex.clear();
  }
}

module.exports = { RoomManager, Room };
