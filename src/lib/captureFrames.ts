import TickerWorker from "./ticker.ts?worker";
import type { Frame, Recording } from "./types";

export interface SamplerOptions {
  fps: number;
  maxWidth: number;
}

export interface Sampler {
  /** Stop sampling and return the recording (frames + real timestamps). */
  stop: () => Recording;
}

/**
 * Samples frames from a video element at a target FPS, scaling each frame down
 * to maxWidth. Works for both a live screen stream and a playing video file.
 *
 * Timing comes from a worker-driven clock (stable cadence) and every frame
 * stores its REAL elapsed timestamp — so the encoder can use true per-frame
 * delays instead of an assumed FPS, which is what keeps motion from juddering.
 */
export function startSampling(video: HTMLVideoElement, opts: SamplerOptions): Sampler {
  const frameLength = Math.max(1, Math.round(1000 / opts.fps));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const frames: Frame[] = [];

  let w = 0;
  let h = 0;
  let startTime = 0;
  let stopped = false;

  const worker = new TickerWorker();
  worker.onmessage = () => {
    if (stopped || video.videoWidth === 0) return;
    if (w === 0) {
      const scale = Math.min(1, opts.maxWidth / video.videoWidth);
      w = Math.max(1, Math.round(video.videoWidth * scale));
      h = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.width = w;
      canvas.height = h;
      startTime = performance.now();
    }
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    frames.push({
      data: img.data.buffer,
      width: w,
      height: h,
      timestamp: frames.length === 0 ? 0 : Math.round(performance.now() - startTime),
    });
  };
  worker.postMessage(frameLength);

  return {
    stop: () => {
      stopped = true;
      worker.terminate();
      const duration = frames.length
        ? frames[frames.length - 1].timestamp + frameLength
        : 0;
      return { width: w, height: h, duration, frames };
    },
  };
}

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export const formatDuration = (ms: number): string => {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
};
