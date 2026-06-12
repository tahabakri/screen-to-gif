import { GIFEncoder, quantize, applyPalette } from "gifenc";
import type { EncodeFrame, WorkerMessage } from "./types";

const post = (m: WorkerMessage, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(m, transfer ?? []);

self.onmessage = (
  e: MessageEvent<{ frames: EncodeFrame[]; delays: number[]; maxColors: number }>
) => {
  const { frames, delays, maxColors } = e.data;
  try {
    const gif = GIFEncoder();
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const rgba = new Uint8Array(f.data);
      const palette = quantize(rgba, maxColors);
      const index = applyPalette(rgba, palette);
      // GIF delays are stored in centiseconds; browsers clamp very small
      // delays, so keep a sane floor.
      const delay = Math.max(20, Math.round(delays[i] ?? 100));
      gif.writeFrame(index, f.width, f.height, { palette, delay });
      post({ type: "progress", value: (i + 1) / frames.length });
    }
    gif.finish();
    const buffer = gif.bytes().buffer as ArrayBuffer;
    post({ type: "done", buffer }, [buffer]);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
