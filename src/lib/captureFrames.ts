import type { Frame } from "./types";

export interface SamplerOptions {
  fps: number;
  maxWidth: number;
}

export interface Sampler {
  frames: Frame[];
  stop: () => void;
}

/**
 * Samples frames from a video element at a target FPS, scaling each frame down
 * to maxWidth. Works for both a live screen stream and a playing video file.
 */
export function startSampling(video: HTMLVideoElement, opts: SamplerOptions): Sampler {
  const frames: Frame[] = [];
  const interval = 1000 / opts.fps;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  let w = 0;
  let h = 0;
  let last = -Infinity;
  let raf = 0;
  let stopped = false;

  const tick = (t: number) => {
    if (stopped) return;
    if (t - last >= interval && video.videoWidth > 0) {
      last = t;
      if (w === 0) {
        const scale = Math.min(1, opts.maxWidth / video.videoWidth);
        w = Math.max(1, Math.round(video.videoWidth * scale));
        h = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.width = w;
        canvas.height = h;
      }
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      frames.push({ data: img.data.buffer, width: w, height: h });
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    frames,
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
    },
  };
}

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
