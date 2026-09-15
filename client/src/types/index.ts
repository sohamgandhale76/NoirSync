export type TrackProvider = 'local' | 'spotify' | 'youtube' | 'apple';

export interface Track {
    id: string;
    title: string;
    artist?: string | null;
    duration: number;

    provider: TrackProvider;
    provider_track_id?: string | null;

    audio_key?: string | null;
    size?: number | null;
    format?: string | null;

    cover_key?: string | null;
    lyrics_key?: string | null;
}
