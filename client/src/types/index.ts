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
    has_cover?: boolean;
    cover_url?: string | null;
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

export interface User {
    id: string;
    email: string | null;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    isGuest: boolean;
    createdAt: number | null;
    updatedAt: number | null;
}

