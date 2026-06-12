import { GIFEncoder, quantize, applyPalette } from "gifenc";
import type { Frame, EncodeOptions, WorkerMessage } from "./types";

const post = (m: WorkerMessage, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(m, transfer ?? []);

self.onmessage = (e: MessageEvent<{ frames: Frame[]; options: EncodeOptions }>) => {
  const { frames, options } = e.data;
  try {
    const gif = GIFEncoder();
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const rgba = new Uint8Array(f.data);
      const palette = quantize(rgba, options.maxColors);
      const index = applyPalette(rgba, palette);
      gif.writeFrame(index, f.width, f.height, { palette, delay: options.delayMs });
      post({ type: "progress", value: (i + 1) / frames.length });
    }
    gif.finish();
    const buffer = gif.bytes().buffer as ArrayBuffer;
    post({ type: "done", buffer }, [buffer]);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
