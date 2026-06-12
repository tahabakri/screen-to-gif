import { useCallback, useEffect, useRef, useState } from "react";
import { startSampling, formatBytes, type Sampler } from "./lib/captureFrames";
import { encodeGif } from "./lib/encodeGif";

type Stage = "idle" | "recording" | "encoding" | "done";

const FPS_OPTIONS = [10, 12, 15, 20] as const;
const SIZE_OPTIONS = [
  { label: "Small", maxWidth: 480 },
  { label: "Medium", maxWidth: 720 },
  { label: "Large", maxWidth: 1080 },
] as const;
const QUALITY_OPTIONS = [
  { label: "High", maxColors: 256 },
  { label: "Balanced", maxColors: 128 },
  { label: "Tiny", maxColors: 64 },
] as const;

const MARQUEE = [
  "Screen → GIF",
  "100% Client-Side",
  "Nothing Uploaded",
  "No Compromise",
  "Raw & Fast",
];

export default function App() {
  const [stage, setStage] = useState<Stage>("idle");
  const [fps, setFps] = useState(15);
  const [sizeIdx, setSizeIdx] = useState(1);
  const [qualityIdx, setQualityIdx] = useState(0);

  const [progress, setProgress] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultSize, setResultSize] = useState(0);
  const [sourceSize, setSourceSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dark, setDark] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("scrgif-theme");
      if (saved) return saved === "dark";
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      return false;
    }
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const samplerRef = useRef<Sampler | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Apply theme class on <html> + persist.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("scrgif-theme", dark ? "dark" : "light");
    } catch {
      /* storage unavailable — ignore */
    }
  }, [dark]);

  const resetResult = useCallback(() => {
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setResultSize(0);
    setSourceSize(null);
    setProgress(0);
    setError(null);
  }, []);

  const runEncode = useCallback(
    async (frames: Parameters<typeof encodeGif>[0]) => {
      if (frames.length === 0) {
        setError("No frames were captured. Try a longer recording.");
        setStage("idle");
        return;
      }
      setFrameCount(frames.length);
      setStage("encoding");
      setProgress(0);
      try {
        const blob = await encodeGif(
          frames,
          {
            delayMs: Math.round(1000 / fps),
            maxColors: QUALITY_OPTIONS[qualityIdx].maxColors,
          },
          setProgress
        );
        setResultUrl(URL.createObjectURL(blob));
        setResultSize(blob.size);
        setStage("done");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Encoding failed.");
        setStage("idle");
      }
    },
    [fps, qualityIdx]
  );

  const stopRecording = useCallback(() => {
    const sampler = samplerRef.current;
    if (!sampler) return;
    sampler.stop();
    samplerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void runEncode(sampler.frames);
  }, [runEncode]);

  const startRecording = useCallback(async () => {
    resetResult();
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen recording isn't supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: fps },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      samplerRef.current = startSampling(video, {
        fps,
        maxWidth: SIZE_OPTIONS[sizeIdx].maxWidth,
      });
      setStage("recording");
      // If the user clicks the browser's native "Stop sharing", end too.
      stream.getVideoTracks()[0].addEventListener("ended", stopRecording);
    } catch (err) {
      // User cancelling the picker is not an error worth showing.
      if (err instanceof DOMException && err.name === "NotAllowedError") return;
      setError(err instanceof Error ? err.message : "Could not start recording.");
    }
  }, [fps, sizeIdx, resetResult, stopRecording]);

  const convertFile = useCallback(
    async (file: File) => {
      resetResult();
      if (!file.type.startsWith("video/")) {
        setError("Please drop a video file (mp4, webm, mov…).");
        return;
      }
      setSourceSize(file.size);
      const url = URL.createObjectURL(file);
      const video = videoRef.current!;
      video.srcObject = null;
      video.src = url;
      video.muted = true;
      try {
        await new Promise<void>((res, rej) => {
          video.onloadedmetadata = () => res();
          video.onerror = () => rej(new Error("Could not read that video."));
        });
        const sampler = startSampling(video, {
          fps,
          maxWidth: SIZE_OPTIONS[sizeIdx].maxWidth,
        });
        setStage("recording"); // reuse "capturing" visual while it plays through
        await video.play();
        await new Promise<void>((res) => {
          video.onended = () => res();
        });
        sampler.stop();
        URL.revokeObjectURL(url);
        await runEncode(sampler.frames);
      } catch (err) {
        URL.revokeObjectURL(url);
        setError(err instanceof Error ? err.message : "Conversion failed.");
        setStage("idle");
      }
    },
    [fps, sizeIdx, resetResult, runEncode]
  );

  // Keyboard shortcuts: R to record, Esc to stop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "r" && stage === "idle") {
        e.preventDefault();
        void startRecording();
      } else if (e.key === "Escape" && stage === "recording") {
        e.preventDefault();
        stopRecording();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, startRecording, stopRecording]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) void convertFile(file);
    },
    [convertFile]
  );

  const busy = stage === "recording" || stage === "encoding";
  const savings =
    sourceSize && resultSize
      ? Math.max(0, Math.round((1 - resultSize / sourceSize) * 100))
      : null;
  const pct = Math.round(progress * 100);
  const statusLabel =
    stage === "recording"
      ? "Capturing"
      : stage === "encoding"
      ? `Encoding ${pct}%`
      : stage === "done"
      ? "Render Complete"
      : "All Systems Operational";

  return (
    <div className="h-screen flex flex-col overflow-hidden theme-bg-page theme-text-main">
      <div className="grain" />
      {/* hidden capture surface */}
      <video ref={videoRef} className="hidden" playsInline muted />

      {/* NAV */}
      <nav className="flex items-stretch justify-between h-14 border-b-2 theme-border shrink-0">
        <div className="flex items-center px-5 bg-lime-400 text-black border-r-2 theme-border select-none">
          <IconBox />
          <span className="ml-3 font-mono text-sm font-bold tracking-tight">
            SCR//GIF
          </span>
        </div>
        <div className="flex items-stretch">
          <div className="hidden sm:flex items-center px-5 border-l-2 theme-border font-mono text-[10px] uppercase tracking-widest theme-text-muted select-none">
            Client-Side · No Upload
          </div>
          <button
            onClick={() => setDark((d) => !d)}
            className="flex items-center gap-2 px-5 border-l-2 theme-border font-mono text-[11px] uppercase tracking-widest hover:bg-[var(--text-main)] hover:text-[var(--bg-page)] transition-colors"
          >
            {dark ? <IconSun /> : <IconMoon />}
            <span className="hidden sm:inline">{dark ? "Light" : "Dark"}</span>
          </button>
        </div>
      </nav>

      {/* MARQUEE */}
      <div className="overflow-hidden bg-lime-400 text-black border-b-2 theme-border py-1.5 shrink-0 select-none">
        <div className="flex w-max animate-marquee">
          {[0, 1].map((g) => (
            <div
              key={g}
              className="flex items-center gap-6 pr-6 font-mono text-xs font-bold uppercase tracking-tight"
            >
              {MARQUEE.map((m, i) => (
                <span key={i} className="flex items-center gap-6">
                  <span>{m}</span>
                  <IconAsterisk />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* MAIN */}
      <main className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[320px_1fr]">
        {/* LEFT — CONFIG / CONTROL DECK */}
        <aside className="flex flex-col min-h-0 border-b-2 md:border-b-0 md:border-r-2 theme-border theme-bg-page">
          <div className="flex items-center justify-between px-5 h-11 border-b-2 theme-border shrink-0">
            <span className="font-mono text-[11px] uppercase tracking-widest theme-text-muted">
              // Config
            </span>
            <span className="font-mono text-[11px] tracking-widest theme-text-muted">
              v2.0
            </span>
          </div>

          <div className="flex-1 min-h-0 p-5 flex flex-col gap-5 overflow-hidden">
            <Selector
              tag="01"
              label="Frame Rate"
              value={String(fps)}
              options={FPS_OPTIONS.map(String)}
              onChange={(v) => setFps(Number(v))}
              disabled={busy}
            />
            <Selector
              tag="02"
              label="Size"
              value={SIZE_OPTIONS[sizeIdx].label}
              options={SIZE_OPTIONS.map((o) => o.label)}
              onChange={(v) =>
                setSizeIdx(SIZE_OPTIONS.findIndex((o) => o.label === v))
              }
              disabled={busy}
            />
            <Selector
              tag="03"
              label="Quality"
              value={QUALITY_OPTIONS[qualityIdx].label}
              options={QUALITY_OPTIONS.map((o) => o.label)}
              onChange={(v) =>
                setQualityIdx(QUALITY_OPTIONS.findIndex((o) => o.label === v))
              }
              disabled={busy}
            />
          </div>

          {/* action area — swaps by stage */}
          <div className="p-5 border-t-2 theme-border shrink-0 flex flex-col gap-3">
            {stage === "idle" && (
              <>
                <button
                  onClick={() => void startRecording()}
                  className="w-full flex items-center justify-center gap-2 py-4 border-2 theme-border bg-[var(--text-main)] text-[var(--bg-page)] font-mono text-sm uppercase tracking-widest font-medium shadow-hard shadow-hard-hover shadow-hard-active transition-all"
                >
                  Start Recording
                  <IconArrowRight />
                </button>
                <p className="font-mono text-[10px] uppercase tracking-widest theme-text-muted text-center">
                  or drop a clip on the stage →
                </p>
              </>
            )}

            {stage === "recording" && (
              <button
                onClick={stopRecording}
                className="w-full flex items-center justify-center gap-2 py-4 border-2 theme-border bg-[var(--danger)] text-white font-mono text-sm uppercase tracking-widest font-medium shadow-hard shadow-hard-hover shadow-hard-active transition-all"
              >
                <IconStopSquare />
                Stop &amp; Render
              </button>
            )}

            {stage === "encoding" && (
              <button
                disabled
                className="w-full flex items-center justify-center gap-2 py-4 border-2 theme-border bg-lime-400 text-black font-mono text-sm uppercase tracking-widest font-medium opacity-80 cursor-not-allowed"
              >
                Rendering… {pct}%
              </button>
            )}

            {stage === "done" && (
              <>
                <a
                  href={resultUrl ?? "#"}
                  download="recording.gif"
                  className="w-full flex items-center justify-center gap-2 py-4 border-2 theme-border bg-lime-400 text-black font-mono text-sm uppercase tracking-widest font-semibold shadow-hard shadow-hard-hover shadow-hard-active transition-all"
                >
                  <IconDownload />
                  Save .GIF
                </a>
                <button
                  onClick={() => {
                    resetResult();
                    setStage("idle");
                  }}
                  className="w-full py-3 border-2 theme-border bg-transparent font-mono text-xs uppercase tracking-widest hover:bg-[var(--text-main)] hover:text-[var(--bg-page)] transition-colors"
                >
                  Record New
                </button>
              </>
            )}
          </div>
        </aside>

        {/* RIGHT — STAGE */}
        <section className="relative min-h-0 flex flex-col theme-bg-card">
          {error && (
            <div
              className="m-4 mb-0 border-2 px-4 py-2 font-mono text-[11px] uppercase tracking-widest shrink-0"
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
            >
              {error}
            </div>
          )}

          {stage === "idle" && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`bru-drop m-4 flex-1 min-h-0 flex flex-col items-center justify-center gap-4 text-center ${
                dragging ? "is-drag" : ""
              }`}
            >
              <IconUpload />
              <div className="font-mono text-sm uppercase tracking-widest">
                Drop a video file
              </div>
              <div className="font-mono text-[11px] uppercase tracking-widest theme-text-muted">
                or press <Kbd>R</Kbd> to record your screen
              </div>
            </div>
          )}

          {stage === "recording" && (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-5 text-center px-6">
              <div className="flex items-center gap-3">
                <span className="w-4 h-4 bg-[var(--danger)] border-2 theme-border animate-blink" />
                <span className="font-mono text-xl uppercase tracking-widest">
                  Recording
                </span>
              </div>
              <div className="font-mono text-[11px] uppercase tracking-widest theme-text-muted">
                Capturing your screen — <Kbd>Esc</Kbd> to stop
              </div>
            </div>
          )}

          {stage === "encoding" && (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-6 px-8 text-center">
              <div className="font-mono text-7xl font-bold tabular-nums leading-none">
                {pct}
                <span className="text-3xl align-top">%</span>
              </div>
              <div className="bru-progress w-full max-w-md">
                <div className="bru-progress__fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="font-mono text-[11px] uppercase tracking-widest theme-text-muted">
                Rendering · {frameCount} frames
              </div>
            </div>
          )}

          {stage === "done" && resultUrl && (
            <div className="flex-1 min-h-0 flex flex-col p-4 gap-3">
              <div className="relative flex-1 min-h-0 border-2 theme-border theme-bg-page flex items-center justify-center overflow-hidden">
                <img
                  src={resultUrl}
                  alt="Your recording as a GIF"
                  className="max-h-full max-w-full object-contain"
                />
                <div className="absolute bottom-0 left-0 px-2 py-1 border-t-2 border-r-2 theme-border theme-bg-card font-mono text-[10px] uppercase tracking-widest">
                  Output.gif
                </div>
              </div>
              <div className="grid grid-cols-3 border-2 theme-border shrink-0 font-mono">
                <Stat label="GIF" value={formatBytes(resultSize)} border />
                <Stat
                  label="Source"
                  value={sourceSize !== null ? formatBytes(sourceSize) : "—"}
                  border
                />
                <Stat
                  label="Saved"
                  value={savings !== null && savings > 0 ? `${savings}%` : "—"}
                  accent={savings !== null && savings > 0}
                />
              </div>
            </div>
          )}
        </section>
      </main>

      {/* STATUS BAR */}
      <div className="h-9 border-t-2 theme-border flex items-center justify-between px-4 shrink-0 font-mono text-[10px] uppercase tracking-widest theme-bg-page">
        <div className="flex items-center gap-2">
          <span className="theme-text-muted">Press</span>
          <Kbd>R</Kbd>
          <span className="theme-text-muted">rec</span>
          <span className="theme-text-muted">/</span>
          <Kbd>Esc</Kbd>
          <span className="theme-text-muted">stop</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span>{statusLabel}</span>
        </div>
      </div>
    </div>
  );
}

function Selector({
  tag,
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  tag: string;
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-[11px] uppercase tracking-widest theme-text-muted">
          {label}
        </span>
        <span className="font-mono text-[11px] tracking-widest theme-text-muted">
          {tag}
        </span>
      </div>
      <div
        className={`grid grid-flow-col auto-cols-fr border-2 theme-border ${
          disabled ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        {options.map((o, i) => {
          const active = o === value;
          return (
            <button
              key={o}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => onChange(o)}
              className={`py-2.5 font-mono text-xs uppercase tracking-wide transition-colors ${
                i > 0 ? "border-l-2 theme-border" : ""
              } ${
                active
                  ? "bg-lime-400 text-black font-semibold"
                  : "hover:bg-[var(--text-main)] hover:text-[var(--bg-page)]"
              }`}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  border,
  accent,
}: {
  label: string;
  value: string;
  border?: boolean;
  accent?: boolean;
}) {
  return (
    <div className={`p-2.5 ${border ? "border-r-2 theme-border" : ""}`}>
      <div className="text-[10px] uppercase tracking-widest theme-text-muted">
        {label}
      </div>
      <div
        className={`text-sm font-bold tabular-nums ${accent ? "text-lime-500" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="bru-kbd">{children}</kbd>;
}

/* lucide-style inline glyphs (currentColor) */

function IconBox() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

function IconArrowRight() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

function IconStopSquare() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" fill="currentColor" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

function IconSun() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function IconAsterisk() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 6v12" />
      <path d="M17.196 9 6.804 15" />
      <path d="m6.804 9 10.392 6" />
    </svg>
  );
}
