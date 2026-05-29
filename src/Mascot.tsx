import { useEffect, useRef } from 'react';
import { KIND_THEMES, SignalKind } from './types';

export type MascotMode = 'idle' | 'walking' | 'running' | 'sleepy' | 'thinking';

interface MascotProps {
  videoSrc: string;
  idleSrc: string;
  kind: SignalKind;
  mode: MascotMode;
  facing: 1 | -1;
  active: boolean;
  size?: number;
}

const ASPECT_RATIO = 720 / 560; // Hermes walk video crop

export function Mascot({ videoSrc, idleSrc, kind, mode, facing, active, size = 130 }: MascotProps) {
  const theme = KIND_THEMES[kind] ?? KIND_THEMES.generic;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wasMovingRef = useRef(false);
  const moving = mode === 'walking' || mode === 'running';

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    if (moving) {
      if (!wasMovingRef.current) {
        try {
          v.currentTime = 0;
        } catch {
          /* seeking before metadata load can throw; ignore */
        }
      }
      v.play().catch(() => {
        /* autoplay may need a gesture; ignore */
      });
    } else {
      v.pause();
    }
    wasMovingRef.current = moving;
  }, [moving]);

  const containerStyle = {
    width: size,
    height: Math.round(size * ASPECT_RATIO),
    '--hermes-glow': theme.glow,
    '--hermes-glow-soft': theme.glowSoft,
  } as React.CSSProperties;

  return (
    <div
      className={[
        'mascot',
        `mascot--mode-${mode}`,
        active ? 'mascot--active' : 'mascot--bg',
        `mascot--kind-${kind}`,
      ].join(' ')}
      style={containerStyle}
    >
      <div className="mascot__halo" aria-hidden="true" />
      <div className="mascot__shadow" aria-hidden="true" />
      <video
        ref={videoRef}
        className={['mascot__media', 'mascot__video', moving ? '' : 'mascot__media--hidden']
          .filter(Boolean)
          .join(' ')}
        src={videoSrc}
        autoPlay
        loop
        muted
        playsInline
        // Use disableRemotePlayback so the picture-in-picture controls never
        // surface — the video is an animated graphic, not media.
        disableRemotePlayback
        style={{ transform: `scaleX(${facing})` }}
      />
      <img
        className={['mascot__media', 'mascot__still', moving ? 'mascot__media--hidden' : '']
          .filter(Boolean)
          .join(' ')}
        src={idleSrc}
        alt=""
        aria-hidden="true"
        style={{ transform: `scaleX(${facing})` }}
      />
      {mode === 'thinking' && (
        <div className="mascot__thinking" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
      {mode === 'sleepy' && (
        <div className="mascot__zzz" aria-hidden="true">
          z
        </div>
      )}
    </div>
  );
}
