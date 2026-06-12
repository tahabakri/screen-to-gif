import { useEffect, useRef, useState } from "react";
import { formatDuration } from "./lib/captureFrames";
import type { Recording } from "./lib/types";

interface EditorProps {
  recording: Recording;
  trimStart: number;
  trimEnd: number;
  speed: number;
  onTrim: (start: number, end: number) => void;
}

/** Largest frame index in [lo, hi] whose timestamp <= ts. */
function indexAtTime(
  frames: Recording["frames"],
  ts: number,
  lo: number,
  hi: number
): number {
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (frames[mid].timestamp <= ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export default function Editor({
  recording,
  trimStart,
  trimEnd,
  speed,
  onTrim,
}: EditorProps) {
  const frames = recording.frames;
  const lastIdx = Math.max(1, frames.length - 1);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef<HTMLCanvasElement | null>(null);

  const rafRef = useRef(0);
  const offsetRef = useRef(0);
  const trimStartRef = useRef(trimStart);
  const trimEndRef = useRef(trimEnd);
  const speedRef = useRef(speed);

  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    trimStartRef.current = trimStart;
    trimEndRef.current = trimEnd;
    speedRef.current = speed;
  });

  const drawIndex = (i: number) => {
    const f = frames[i];
    if (!f) return;
    let src = sourceRef.current;
    if (!src) {
      src = document.createElement("canvas");
      sourceRef.current = src;
    }
    if (src.width !== f.width || src.height !== f.height) {
      src.width = f.width;
      src.height = f.height;
    }
    const sctx = src.getContext("2d")!;
    sctx.putImageData(
      new ImageData(new Uint8ClampedArray(f.data), f.width, f.height),
      0,
      0
    );

    const cv = canvasRef.current;
    if (cv) {
      const cx = cv.getContext("2d")!;
      cx.clearRect(0, 0, cv.width, cv.height);
      const scale = Math.min(cv.width / f.width, cv.height / f.height);
      const dw = f.width * scale;
      const dh = f.height * scale;
      cx.drawImage(src, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
    }
    const ph = playheadRef.current;
    if (ph) ph.style.left = `${(i / lastIdx) * 100}%`;
  };

  const buildStrip = () => {
    const strip = stripCanvasRef.current;
    const host = stripRef.current;
    if (!strip || !host) return;
    const W = Math.max(1, host.clientWidth);
    const H = 52;
    strip.width = W;
    strip.height = H;
    const sctx = strip.getContext("2d")!;
    let src = sourceRef.current;
    if (!src) {
      src = document.createElement("canvas");
      sourceRef.current = src;
    }
    const srcctx = src.getContext("2d")!;
    const N = Math.max(1, Math.min(frames.length, Math.floor(W / 42)));
    const sliceW = W / N;
    for (let k = 0; k < N; k++) {
      const fi = Math.round((k / Math.max(1, N - 1)) * lastIdx);
      const f = frames[fi];
      if (!f) continue;
      if (src.width !== f.width || src.height !== f.height) {
        src.width = f.width;
        src.height = f.height;
      }
      srcctx.putImageData(
        new ImageData(new Uint8ClampedArray(f.data), f.width, f.height),
        0,
        0
      );
      const scale = Math.max(sliceW / f.width, H / f.height);
      const dw = f.width * scale;
      const dh = f.height * scale;
      sctx.drawImage(src, k * sliceW + (sliceW - dw) / 2, (H - dh) / 2, dw, dh);
    }
  };

  const pause = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    setPlaying(false);
  };

  const play = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    offsetRef.current = performance.now();
    setPlaying(true);
    const loop = () => {
      const a = trimStartRef.current;
      const b = trimEndRef.current;
      const startTs = frames[a].timestamp;
      const endTs = frames[b].timestamp;
      const span = Math.max(1, endTs - startTs);
      const elapsed = ((performance.now() - offsetRef.current) * speedRef.current) % span;
      drawIndex(indexAtTime(frames, startTs + elapsed, a, b));
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  // mount: size the preview canvas, build the filmstrip, draw the in-point.
  useEffect(() => {
    const fit = () => {
      const cv = canvasRef.current;
      const host = containerRef.current;
      if (cv && host) {
        cv.width = Math.max(1, host.clientWidth);
        cv.height = Math.max(1, host.clientHeight);
      }
      buildStrip();
      drawIndex(trimStartRef.current);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  // when trim changes while paused, show the handle position.
  useEffect(() => {
    if (!playing) drawIndex(trimStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimStart, trimEnd]);

  const seekFromEvent = (clientX: number) => {
    const rect = stripRef.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    drawIndex(Math.round(frac * lastIdx));
  };

  const onStripDown = (e: React.PointerEvent) => {
    pause();
    seekFromEvent(e.clientX);
    const move = (ev: PointerEvent) => seekFromEvent(ev.clientX);
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  const onHandleDown = (which: "start" | "end") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    pause();
    const rect = stripRef.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      const idx = Math.round(frac * lastIdx);
      if (which === "start") {
        onTrim(Math.min(idx, trimEndRef.current - 1), trimEndRef.current);
      } else {
        onTrim(trimStartRef.current, Math.max(idx, trimStartRef.current + 1));
      }
      drawIndex(idx);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  const startFrac = (trimStart / lastIdx) * 100;
  const endFrac = (trimEnd / lastIdx) * 100;
  const outMs =
    (frames[trimEnd].timestamp - frames[trimStart].timestamp) / speed;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 rounded-xl border-2 theme-border overflow-hidden"
        style={{ background: "var(--bg)" }}
      >
        <canvas ref={canvasRef} className="block w-full h-full" />
        <button
          onClick={() => (playing ? pause() : play())}
          className="btn btn-white !px-3 !py-2 !text-xs absolute bottom-2 left-2"
        >
          {playing ? <IconPause /> : <IconPlay />}
          {playing ? "Pause" : "Play"}
        </button>
      </div>

      <div className="shrink-0">
        <div
          ref={stripRef}
          onPointerDown={onStripDown}
          className="relative rounded-lg border-2 theme-border overflow-hidden select-none"
          style={{ height: 52, cursor: "pointer" }}
        >
          <canvas ref={stripCanvasRef} className="block w-full" style={{ height: 52 }} />
          {/* dim trimmed-out regions */}
          <div
            className="absolute inset-y-0 left-0 bg-black/45 pointer-events-none"
            style={{ width: `${startFrac}%` }}
          />
          <div
            className="absolute inset-y-0 right-0 bg-black/45 pointer-events-none"
            style={{ width: `${100 - endFrac}%` }}
          />
          {/* playhead */}
          <div
            ref={playheadRef}
            className="absolute inset-y-0 w-0.5 pointer-events-none"
            style={{ background: "var(--danger)", left: 0 }}
          />
          {/* trim handles */}
          <div
            onPointerDown={onHandleDown("start")}
            className="absolute inset-y-0 flex items-center justify-center cursor-ew-resize"
            style={{ left: `${startFrac}%`, width: 16, marginLeft: -8 }}
          >
            <div
              className="h-7 w-1.5 rounded-sm border-2 theme-border"
              style={{ background: "var(--green)" }}
            />
          </div>
          <div
            onPointerDown={onHandleDown("end")}
            className="absolute inset-y-0 flex items-center justify-center cursor-ew-resize"
            style={{ left: `${endFrac}%`, width: 16, marginLeft: -8 }}
          >
            <div
              className="h-7 w-1.5 rounded-sm border-2 theme-border"
              style={{ background: "var(--green)" }}
            />
          </div>
        </div>
        <div className="flex justify-between mt-1.5 text-[11px] font-medium theme-text-muted">
          <span>
            {formatDuration(outMs)} · {trimEnd - trimStart + 1} frames
          </span>
          <span>drag the handles to trim</span>
        </div>
      </div>
    </div>
  );
}

function IconPlay() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4.5v15l13-7.5z" fill="currentColor" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" />
      <rect x="13.8" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" />
    </svg>
  );
}
