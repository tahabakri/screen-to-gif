export interface Frame {
  data: ArrayBuffer; // RGBA pixels
  width: number;
  height: number;
  timestamp: number; // ms since capture start (real elapsed time)
}

export interface Recording {
  width: number;
  height: number;
  duration: number; // ms
  frames: Frame[];
}

/** A frame ready to encode — pixels only, delay carried separately. */
export interface EncodeFrame {
  data: ArrayBuffer;
  width: number;
  height: number;
}

export type WorkerMessage =
  | { type: "progress"; value: number }
  | { type: "done"; buffer: ArrayBuffer }
  | { type: "error"; message: string };
