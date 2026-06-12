import GifWorker from "./gif.worker.ts?worker";
import type { Frame, EncodeOptions, WorkerMessage } from "./types";

export function encodeGif(
  frames: Frame[],
  options: EncodeOptions,
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
    worker.postMessage({ frames, options }, transfer);
  });
}
