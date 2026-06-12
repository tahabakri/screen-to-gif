export interface Frame {
  data: ArrayBuffer; // RGBA pixels
  width: number;
  height: number;
}

export interface EncodeOptions {
  delayMs: number; // per-frame delay
  maxColors: number; // palette size (quality)
}

export type WorkerMessage =
  | { type: "progress"; value: number }
  | { type: "done"; buffer: ArrayBuffer }
  | { type: "error"; message: string };
