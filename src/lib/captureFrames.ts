import type { Frame } from "./types";

export interface SamplerOptions {
  fps: number;
  maxWidth: number;
}

export interface Sampler {
  /** Stop sampling and return the captured frames as RGBA buffers. */
  stop: () => Promise<Frame[]>;
}

/**
 * Samples frames from a video element at a target FPS, scaling each frame down
 * to maxWidth. Works for both a live screen stream and a playing video file.
 *
 * Perf: during capture we only grab lightweight `ImageBitmap`s via
 * `createImageBitmap` (decode + downscale happen off the main thread), so the
 * UI stays smooth while recording. The expensive `getImageData` pixel readback
 * is deferred to `stop()`, i.e. it runs during the encode phase, not the live
 * capture. Falls back to inline readback on browsers without createImageBitmap.
 */
export function startSampling(video: HTMLVideoElement, opts: SamplerOptions): Sampler {
  const interval = 1000 / opts.fps;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const canBitmap = typeof createImageBitmap === "function";

  let w = 0;
  let h = 0;
  let last = -Infinity;
  let raf = 0;
  let stopped = false;

  const bitmapJobs: Promise<ImageBitmap | null>[] = [];
  const inlineFrames: Frame[] = [];

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
      if (canBitmap) {
        // Off-thread decode + scale — does not block the main thread.
        bitmapJobs.push(
          createImageBitmap(video, {
            resizeWidth: w,
            resizeHeight: h,
            resizeQuality: "medium",
          }).catch(() => null)
        );
      } else {
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        inlineFrames.push({ data: img.data.buffer, width: w, height: h });
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    stop: async () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (!canBitmap) return inlineFrames;

      // Heavy pixel extraction happens here, off the live-capture hot path.
      const bitmaps = await Promise.all(bitmapJobs);
      const frames: Frame[] = [];
      for (const bmp of bitmaps) {
        if (!bmp) continue;
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        ctx.drawImage(bmp, 0, 0);
        const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
        frames.push({ data: img.data.buffer, width: bmp.width, height: bmp.height });
        bmp.close();
      }
      return frames;
    },
  };
}

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
