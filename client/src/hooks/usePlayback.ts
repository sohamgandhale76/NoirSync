import { useRef, useEffect } from 'react';
import { LocalPlaybackAdapter } from '../lib/playback/LocalPlaybackAdapter';

/**
 * Hook to manage a PlaybackAdapter tied to an HTMLAudioElement.
 */
export function usePlayback(audioRef: React.RefObject<HTMLAudioElement | null>) {
    const adapterRef = useRef<LocalPlaybackAdapter | null>(null);

    if (!adapterRef.current) {
        adapterRef.current = new LocalPlaybackAdapter();
    }

    useEffect(() => {
        if (audioRef.current && adapterRef.current) {
            adapterRef.current.bind(audioRef.current);
        }

        return () => {
            // Unbind on unmount, but the adapter instance can persist across re-renders
            if (adapterRef.current) {
                adapterRef.current.unbind();
            }
        };
    }, [audioRef]);

    return adapterRef.current;
}
