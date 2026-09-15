export type PlaybackEvent = 'timeupdate' | 'ended' | 'loadedmetadata' | 'play' | 'pause' | 'durationchange' | 'waiting' | 'playing' | 'canplay' | 'progress';

export interface PlaybackAdapter {
    play(): Promise<void>;
    pause(): void;
    seekTo(time: number): void;

    getCurrentTime(): number;
    getDuration(): number;
    getBuffered(): TimeRanges | null;
    getReadyState(): number;
    
    setVolume(volume: number): void;
    
    isReady(): boolean;

    on(event: PlaybackEvent, callback: (...args: any[]) => void): () => void;

    destroy(): void;

    setSrc(url: string): void;
    getSrc(): string;
}
