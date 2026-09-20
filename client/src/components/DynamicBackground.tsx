import { useEffect, useState } from 'react';
import { SERVER_URL } from '../lib/constants';

interface DynamicBackgroundProps {
  coverFilename: string | null;
  songName: string | null;
}

export function DynamicBackground({ coverFilename, songName }: DynamicBackgroundProps) {
  const [colors, setColors] = useState<[string, string]>(['#121212', '#1a1a1a']);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setImageLoaded(false);
    setImageError(false);
  }, [coverFilename]);

  useEffect(() => {
    if (!songName) return;
    // Generate two distinct hue values based on song name string hash
    let hash1 = 0;
    let hash2 = 0;
    for (let i = 0; i < songName.length; i++) {
      hash1 = songName.charCodeAt(i) + ((hash1 << 5) - hash1);
      hash2 = songName.charCodeAt(songName.length - 1 - i) + ((hash2 << 5) - hash2);
    }
    const h1 = Math.abs(hash1 % 360);
    const h2 = Math.abs((hash2 + 120) % 360);
    setColors([`hsl(${h1}, 70%, 25%)`, `hsl(${h2}, 70%, 18%)`]);
  }, [songName]);

  const hasValidCover = Boolean(coverFilename && !imageError);

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none select-none z-0">
      {/* Cover-based cinematic background */}
      {hasValidCover && (
        <div key={coverFilename} className="absolute inset-0 transition-opacity duration-1000 ease-in-out">
          <img
            src={coverFilename?.startsWith('http') || coverFilename?.startsWith('data:') ? coverFilename : `${SERVER_URL || ''}/api/library/covers/${coverFilename}`}
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageError(true)}
            className={`absolute inset-0 w-full h-full object-cover scale-110 blur-2xl md:blur-3xl saturate-[130%] transition-opacity duration-1000 ${
              imageLoaded ? 'opacity-60' : 'opacity-0'
            }`}
            alt=""
          />
          {/* Dark noir translucent overlay and vignette for readability */}
          <div className="absolute inset-0 bg-gradient-to-b from-noir-black/80 via-noir-black/70 to-noir-black/95" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-transparent via-noir-black/40 to-noir-black/90" />
        </div>
      )}

      {/* Fallback adaptive color blobs (when no cover exists, or before image loads, or on image error) */}
      {(!hasValidCover || !imageLoaded) && songName && (
        <>
          <div
            className="absolute -top-[20%] -left-[20%] w-[90%] h-[90%] rounded-full opacity-[0.22] blur-[120px] mix-blend-screen animate-blob-slow transition-all duration-[3s]"
            style={{ backgroundColor: colors[0] }}
          />
          <div
            className="absolute -bottom-[20%] -right-[20%] w-[90%] h-[90%] rounded-full opacity-[0.18] blur-[120px] mix-blend-screen animate-blob-reverse transition-all duration-[3s]"
            style={{ backgroundColor: colors[1] }}
          />
        </>
      )}
    </div>
  );
}
