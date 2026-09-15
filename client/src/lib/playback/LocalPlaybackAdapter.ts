import { PlaybackAdapter, PlaybackEvent } from './PlaybackAdapter';

export class LocalPlaybackAdapter implements PlaybackAdapter {
    private audio: HTMLAudioElement | null = null;
    private listeners: Map<PlaybackEvent, Set<(...args: any[]) => void>> = new Map();
    private activeDomListeners: Map<string, (e: Event) => void> = new Map();

    constructor() {
        // Initialize listener sets
        const events: PlaybackEvent[] = ['timeupdate', 'ended', 'loadedmetadata', 'play', 'pause', 'durationchange', 'waiting', 'playing', 'canplay', 'progress'];
        events.forEach(e => this.listeners.set(e, new Set()));
    }

    /**
     * Binds this adapter to an actual HTMLAudioElement.
     */
    bind(audioElement: HTMLAudioElement) {
        if (this.audio === audioElement) {
            return;
        }
        if (this.audio) {
            this.unbind();
        }
        this.audio = audioElement;
        
        // Attach DOM listeners that forward to our event system
        const bindEvent = (eventName: PlaybackEvent, domEventName: string) => {
            const handler = (e: Event) => {
                const callbacks = this.listeners.get(eventName);
                if (callbacks) {
                    callbacks.forEach(cb => cb(e));
                }
            };
            this.activeDomListeners.set(domEventName, handler);
            this.audio?.addEventListener(domEventName, handler);
        };

        bindEvent('timeupdate', 'timeupdate');
        bindEvent('ended', 'ended');
        bindEvent('loadedmetadata', 'loadedmetadata');
        bindEvent('play', 'play');
        bindEvent('pause', 'pause');
        bindEvent('durationchange', 'durationchange');
        bindEvent('waiting', 'waiting');
        bindEvent('playing', 'playing');
        bindEvent('canplay', 'canplay');
        bindEvent('progress', 'progress');
    }

    unbind() {
        if (!this.audio) return;
        this.activeDomListeners.forEach((handler, domEventName) => {
            this.audio?.removeEventListener(domEventName, handler);
        });
        this.activeDomListeners.clear();
        this.audio = null;
    }

    async play(): Promise<void> {
        if (!this.audio) return;
        return this.audio.play();
    }

    pause(): void {
        if (!this.audio) return;
        this.audio.pause();
    }

    seekTo(time: number): void {
        if (!this.audio) return;
        this.audio.currentTime = time;
    }

    getCurrentTime(): number {
        return this.audio ? this.audio.currentTime : 0;
    }

    getDuration(): number {
        return this.audio ? this.audio.duration : 0;
    }

    getBuffered(): TimeRanges | null {
        return this.audio ? this.audio.buffered : null;
    }

    getReadyState(): number {
        return this.audio ? this.audio.readyState : 0;
    }


    setVolume(volume: number): void {
        if (!this.audio) return;
        this.audio.volume = volume;
    }

    isReady(): boolean {
        // readyState >= 1 means HAVE_METADATA
        return this.audio ? this.audio.readyState >= 1 : false;
    }

    on(event: PlaybackEvent, callback: (...args: any[]) => void): () => void {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            callbacks.add(callback);
        }
        return () => {
            if (callbacks) {
                callbacks.delete(callback);
            }
        };
    }

    destroy(): void {
        if (this.audio && this.audio.src.startsWith('blob:')) {
            URL.revokeObjectURL(this.audio.src);
        }
        this.unbind();
        this.listeners.clear();
    }

    // --- Local-specific helper methods for setting source ---

    setSrc(url: string) {
        if (!this.audio) return;
        const currentSrc = this.audio.src;
        if (currentSrc && currentSrc.startsWith('blob:')) {
            URL.revokeObjectURL(currentSrc);
        }
        this.audio.src = url;
        this.audio.load();
    }
    
    getSrc(): string {
        return this.audio ? this.audio.src : '';
    }

    getAudioElement(): HTMLAudioElement | null {
        return this.audio;
    }
}
