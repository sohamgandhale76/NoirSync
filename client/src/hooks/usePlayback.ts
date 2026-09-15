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

    // Bind adapter to audio element whenever available (idempotent)
    useEffect(() => {
        if (audioRef.current && adapterRef.current) {
            adapterRef.current.bind(audioRef.current);
        }
    });

    // Clean up DOM listeners on component unmount
    useEffect(() => {
        return () => {
            adapterRef.current?.unbind();
        };
    }, []);

    return adapterRef.current;
}
