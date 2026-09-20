export type TrackProvider = 'local' | 'spotify' | 'youtube' | 'apple';

export interface Track {
    id: string;
    title: string;
    artist?: string | null;
    album?: string | null;
    duration: number;

    provider: TrackProvider;
    provider_track_id?: string | null;
    external_url?: string | null;

    audio_key?: string | null;
    size?: number | null;
    format?: string | null;

    cover_key?: string | null;
    lyrics_key?: string | null;
}

/**
 * Universal track model representing any music item across local & streaming providers.
 * Compatible with the existing Track interface.
 */
export interface UniversalTrack extends Track {
    isPlayable?: boolean;
}

export interface PlaylistTrack extends UniversalTrack {
    playlist_track_id: string;
    position: number;
    added_at: number;
}

export interface Playlist {
    id: string;
    user_id: string;
    name: string;
    description?: string | null;
    created_at: number;
    updated_at: number;
    track_count: number;
    tracks?: PlaylistTrack[];
}
