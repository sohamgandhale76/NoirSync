import { PlaybackAdapter, PlaybackEvent } from './PlaybackAdapter';
import { loadSpotifySDK } from '../spotify/sdkLoader';
import { SERVER_URL } from '../constants';

export class SpotifyPlaybackAdapter implements PlaybackAdapter {
  private player: any = null;
  private deviceId: string | null = null;
  private currentSpotifyUri: string = '';
  private currentTrackId: string = '';
  private trackLoadedInPlayer: boolean = false;
  private isPlayerReady: boolean = false;
  private isPaused: boolean = true;
  private positionMs: number = 0;
  private durationMs: number = 0;
  private lastPositionUpdateTime: number = 0;
  private volume: number = 1.0;
  private initPromise: Promise<void> | null = null;
  private isDestroyed: boolean = false;

  private listeners: Map<PlaybackEvent, Set<(...args: any[]) => void>> = new Map();

  constructor() {
    const events: PlaybackEvent[] = [
      'timeupdate', 'ended', 'loadedmetadata', 'play', 'pause',
      'durationchange', 'waiting', 'playing', 'canplay', 'progress'
    ];
    events.forEach(e => this.listeners.set(e, new Set()));
  }

  /**
   * Fetch short-lived access token from server endpoint.
   * Called on-demand by Spotify.Player getOAuthToken callback.
   */
  private async fetchPlaybackToken(): Promise<string> {
    const res = await fetch(`${SERVER_URL || ''}/api/music/spotify/playback-token`, {
      credentials: 'include',
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 404 || res.status === 403) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Spotify account not connected or unauthorized');
      }
      throw new Error(`Failed to fetch Spotify playback token: HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data || !data.accessToken) {
      throw new Error('Invalid token response from server');
    }
    return data.accessToken;
  }

  /**
   * Initializes the Spotify.Player instance safely (idempotent, single instance).
   */
  public async init(): Promise<void> {
    if (this.isDestroyed) return;
    if (this.player) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const SpotifySDK = await loadSpotifySDK();
      if (this.isDestroyed) return;

      this.player = new SpotifySDK.Player({
        name: 'NoirSync Web Player',
        getOAuthToken: async (cb: (token: string) => void) => {
          try {
            const token = await this.fetchPlaybackToken();
            cb(token);
          } catch (err) {
            this.emit('waiting', err);
          }
        },
        volume: this.volume
      });

      // SDK Events
      this.player.addListener('ready', ({ device_id }: { device_id: string }) => {
        this.deviceId = device_id;
        this.isPlayerReady = true;
        this.emit('canplay');
      });

      this.player.addListener('not_ready', () => {
        this.isPlayerReady = false;
        this.deviceId = null;
      });

      this.player.addListener('player_state_changed', (state: any) => {
        if (!state) {
          this.isPaused = true;
          this.emit('pause');
          return;
        }

        const prevPaused = this.isPaused;
        this.isPaused = state.paused;
        this.positionMs = state.position || 0;
        this.durationMs = state.duration || 0;
        this.lastPositionUpdateTime = Date.now();

        if (state.track_window?.current_track) {
          const trackUri = state.track_window.current_track.uri;
          if (trackUri === this.currentSpotifyUri) {
            this.trackLoadedInPlayer = true;
          }
        }

        this.emit('timeupdate');
        this.emit('durationchange');

        if (prevPaused && !state.paused) {
          this.emit('play');
          this.emit('playing');
        } else if (!prevPaused && state.paused) {
          this.emit('pause');
        }

        if (state.position === 0 && state.paused && state.restrictions?.disallow_resuming_reasons) {
          this.emit('ended');
        }
      });

      this.player.addListener('initialization_error', ({ message }: { message: string }) => {
        this.emit('waiting', new Error(message));
      });

      this.player.addListener('authentication_error', ({ message }: { message: string }) => {
        this.emit('waiting', new Error(message));
      });

      this.player.addListener('account_error', ({ message }: { message: string }) => {
        this.emit('waiting', new Error(message));
      });

      await this.player.connect();
    })();

    return this.initPromise;
  }

  /**
   * Unlock browser autoplay restrictions on user gesture.
   */
  public async activateElement(): Promise<void> {
    if (this.player && typeof this.player.activateElement === 'function') {
      await this.player.activateElement();
    }
  }

  /**
   * Primary Playback Control:
   * Uses Spotify Web Playback SDK as primary engine.
   * If current track is not yet cued on this player, issues start command to Spotify Connect.
   * Subsequent play calls use player.resume().
   */
  async play(positionMs?: number): Promise<void> {
    if (!this.player) {
      await this.init();
    }

    if (typeof this.player.activateElement === 'function') {
      await this.player.activateElement().catch(() => {});
    }

    // If the track is already loaded/cued in player, use SDK resume() directly
    if (this.trackLoadedInPlayer && this.isPlayerReady) {
      if (typeof positionMs === 'number' && positionMs >= 0) {
        await this.player.seek(Math.round(positionMs)).catch(() => {});
        this.positionMs = Math.round(positionMs);
        this.lastPositionUpdateTime = Date.now();
      }
      await this.player.resume();
      this.isPaused = false;
      this.emit('play');
      this.emit('playing');
      return;
    }

    // Cue/transfer track to this browser device
    if (!this.deviceId) {
      throw new Error('Spotify player device is not ready yet');
    }

    if (!this.currentSpotifyUri) {
      throw new Error('No Spotify track URI set');
    }

    const token = await this.fetchPlaybackToken();
    const body: Record<string, any> = {
      uris: [this.currentSpotifyUri]
    };
    if (typeof positionMs === 'number' && positionMs > 0) {
      body.position_ms = Math.round(positionMs);
      this.positionMs = Math.round(positionMs);
    }

    const playRes = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${this.deviceId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });

    if (!playRes.ok) {
      const errBody = await playRes.text().catch(() => '');
      if (playRes.status === 403) {
        throw new Error('Spotify Premium required for Web Playback');
      }
      throw new Error(`Spotify playback start failed (HTTP ${playRes.status}): ${errBody}`);
    }

    this.trackLoadedInPlayer = true;
    this.isPaused = false;
    this.lastPositionUpdateTime = Date.now();
    this.emit('play');
    this.emit('playing');
  }

  getPlaybackState() {
    return {
      isReady: this.isPlayerReady,
      deviceId: this.deviceId,
      currentSpotifyUri: this.currentSpotifyUri,
      currentTrackId: this.currentTrackId,
      isPlaying: !this.isPaused,
      positionMs: this.positionMs,
      durationMs: this.durationMs
    };
  }

  pause(): void {
    if (this.player) {
      this.player.pause().catch(() => {});
      this.isPaused = true;
      this.emit('pause');
    }
  }

  seekTo(timeInSeconds: number): void {
    if (this.player) {
      const ms = Math.max(0, Math.round(timeInSeconds * 1000));
      this.player.seek(ms).catch(() => {});
      this.positionMs = ms;
      this.lastPositionUpdateTime = Date.now();
      this.emit('timeupdate');
    }
  }

  getCurrentTime(): number {
    if (this.isPaused) {
      return this.positionMs / 1000;
    }
    const elapsed = Date.now() - this.lastPositionUpdateTime;
    const estimatedMs = Math.min(this.durationMs || Infinity, this.positionMs + elapsed);
    return estimatedMs / 1000;
  }

  getDuration(): number {
    return this.durationMs / 1000;
  }

  getBuffered(): TimeRanges | null {
    return null;
  }

  getReadyState(): number {
    return this.isPlayerReady ? 4 : 0;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.player && typeof this.player.setVolume === 'function') {
      this.player.setVolume(this.volume).catch(() => {});
    }
  }

  isReady(): boolean {
    return this.isPlayerReady && Boolean(this.deviceId);
  }

  on(event: PlaybackEvent, callback: (...args: any[]) => void): () => void {
    const set = this.listeners.get(event);
    if (set) {
      set.add(callback);
    }
    return () => {
      set?.delete(callback);
    };
  }

  private emit(event: PlaybackEvent, ...args: any[]) {
    const set = this.listeners.get(event);
    if (set) {
      set.forEach(cb => {
        try {
          cb(...args);
        } catch {
          // Prevent listener errors from breaking SDK adapter
        }
      });
    }
  }

  /**
   * Normalizes track identity to Spotify URI:
   * Interprets input as Spotify track identity/URI, never an audio URL.
   */
  setSrc(urlOrUriOrId: string): void {
    if (!urlOrUriOrId) {
      this.currentSpotifyUri = '';
      this.currentTrackId = '';
      this.trackLoadedInPlayer = false;
      return;
    }

    let trackId = urlOrUriOrId;
    if (trackId.startsWith('spotify:track:')) {
      trackId = trackId.replace('spotify:track:', '');
    } else if (trackId.startsWith('ext_spotify_')) {
      trackId = trackId.replace('ext_spotify_', '');
    }

    const newUri = `spotify:track:${trackId}`;
    if (newUri !== this.currentSpotifyUri) {
      this.currentSpotifyUri = newUri;
      this.currentTrackId = trackId;
      this.trackLoadedInPlayer = false;
      this.positionMs = 0;
      this.emit('loadedmetadata');
    }
  }

  getSrc(): string {
    return this.currentSpotifyUri;
  }

  getDeviceId(): string | null {
    return this.deviceId;
  }

  getCurrentTrackId(): string {
    return this.currentTrackId;
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.player) {
      try {
        this.player.disconnect();
      } catch {}
      this.player = null;
    }
    this.deviceId = null;
    this.isPlayerReady = false;
    this.listeners.forEach(set => set.clear());
  }
}
