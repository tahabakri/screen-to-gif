import GifWorker from "./gif.worker.ts?worker";
import type { EncodeFrame, WorkerMessage } from "./types";

/**
 * Encodes frames into a GIF in a Web Worker. Each frame carries its own delay
 * (ms), so playback timing matches the real recording. Frame buffers are
 * transferred to the worker — pass copies if you need to keep the originals.
 */
export function encodeGif(
  frames: EncodeFrame[],
  delays: number[],
  maxColors: number,
  onProgress?: (value: number) => void
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new GifWorker();
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === "progress") onProgress?.(m.value);
      else if (m.type === "done") {
        resolve(new Blob([m.buffer], { type: "image/gif" }));
        worker.terminate();
      } else {
        reject(new Error(m.message));
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message));
      worker.terminate();
    };
    const transfer = frames.map((f) => f.data);
    worker.postMessage({ frames, delays, maxColors }, transfer);
  });
}
