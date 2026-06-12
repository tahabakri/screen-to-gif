import { useCallback, useEffect, useRef, useState } from "react";
import {
  startSampling,
  formatBytes,
  formatDuration,
  type Sampler,
} from "./lib/captureFrames";
import { encodeGif } from "./lib/encodeGif";
import type { Recording } from "./lib/types";
import Editor from "./Editor";

type Stage = "idle" | "recording" | "importing" | "editing" | "encoding" | "done";

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
const SPEED_OPTIONS = ["0.5×", "1×", "2×"] as const;

export default function App() {
  const [stage, setStage] = useState<Stage>("idle");
  const [fps, setFps] = useState(15);
  const [sizeIdx, setSizeIdx] = useState(1);
  const [qualityIdx, setQualityIdx] = useState(0);

  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [recId, setRecId] = useState(0);

  const [progress, setProgress] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultSize, setResultSize] = useState(0);
  const [sourceSize, setSourceSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dark, setDark] = useState<boolean>(() => {
    try {
      return localStorage.getItem("scrgif-theme") === "dark";
    } catch {
      return false;
    }
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const samplerRef = useRef<Sampler | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingRef = useRef<Recording | null>(null);

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

  const enterEditing = useCallback((rec: Recording) => {
    recordingRef.current = rec;
    setTrimStart(0);
    setTrimEnd(Math.max(0, rec.frames.length - 1));
    setSpeed(1);
    setProgress(0);
    setRecId((n) => n + 1);
    setStage("editing");
  }, []);

  const stopRecording = useCallback(() => {
    const sampler = samplerRef.current;
    if (!sampler) return;
    samplerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const rec = sampler.stop();
    if (rec.frames.length === 0) {
      setError("No frames were captured. Try a longer recording.");
      setStage("idle");
      return;
    }
    enterEditing(rec);
  }, [enterEditing]);

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
        setStage("importing");
        await video.play();
        // Resolve when playback ends. A plain `onended` can hang forever on
        // streams/malformed files (duration === Infinity, no end event), which
        // would let the sampler run away — so also stop at a finite duration or
        // when playback stalls.
        await new Promise<void>((res) => {
          let lastT = -1;
          let stalls = 0;
          const finish = () => {
            clearInterval(iv);
            res();
          };
          const iv = window.setInterval(() => {
            const d = video.duration;
            if (video.ended) return finish();
            if (isFinite(d) && d > 0 && video.currentTime >= d - 0.05) return finish();
            if (video.currentTime === lastT) {
              if (++stalls >= 8) return finish(); // ~0.8s with no progress
            } else {
              stalls = 0;
              lastT = video.currentTime;
            }
          }, 100);
          video.onended = finish;
        });
        const rec = sampler.stop();
        URL.revokeObjectURL(url);
        if (rec.frames.length === 0) {
          setError("That video produced no frames.");
          setStage("idle");
          return;
        }
        enterEditing(rec);
      } catch (err) {
        URL.revokeObjectURL(url);
        setError(err instanceof Error ? err.message : "Conversion failed.");
        setStage("idle");
      }
    },
    [fps, sizeIdx, resetResult, enterEditing]
  );

  const exportGif = useCallback(async () => {
    const rec = recordingRef.current;
    if (!rec) return;
    const a = Math.min(trimStart, trimEnd);
    const b = Math.max(trimStart, trimEnd);
    const slice = rec.frames.slice(a, b + 1);
    if (slice.length === 0) {
      setError("Nothing to export.");
      return;
    }
    // True per-frame delays from timestamps, scaled by playback speed.
    const delays: number[] = [];
    for (let i = 0; i < slice.length; i++) {
      const next = slice[i + 1];
      if (next) {
        delays.push(Math.max(20, (next.timestamp - slice[i].timestamp) / speed));
      } else {
        delays.push(delays.length ? delays[delays.length - 1] : Math.max(20, 100 / speed));
      }
    }
    // Copy buffers so the originals survive (the user may edit again).
    const copies = slice.map((f) => ({
      data: f.data.slice(0),
      width: f.width,
      height: f.height,
    }));
    setFrameCount(copies.length);
    setStage("encoding");
    setProgress(0);
    try {
      const blob = await encodeGif(
        copies,
        delays,
        QUALITY_OPTIONS[qualityIdx].maxColors,
        setProgress
      );
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      setResultSize(blob.size);
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Encoding failed.");
      setStage("editing");
    }
  }, [trimStart, trimEnd, speed, qualityIdx]);

  const discard = useCallback(() => {
    recordingRef.current = null;
    resetResult();
    setStage("idle");
  }, [resetResult]);

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

  const pickFile = useCallback(() => fileInputRef.current?.click(), []);
  const onFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-picking the same file
      if (file) void convertFile(file);
    },
    [convertFile]
  );

  const busy =
    stage === "recording" || stage === "importing" || stage === "encoding";
  const savings =
    sourceSize && resultSize
      ? Math.max(0, Math.round((1 - resultSize / sourceSize) * 100))
      : null;
  const pct = Math.round(progress * 100);
  const captureStage =
    stage === "idle" ||
    stage === "recording" ||
    stage === "importing" ||
    stage === "encoding";
  const recFrames = recordingRef.current?.frames.length ?? 0;

  const head =
    stage === "recording"
      ? { title: "Recording", sub: "Capturing your screen…" }
      : stage === "importing"
      ? { title: "Importing", sub: "Reading your video…" }
      : stage === "editing"
      ? { title: "Edit", sub: "Trim and tune, then export." }
      : stage === "encoding"
      ? { title: "Rendering", sub: "Building your GIF…" }
      : stage === "done"
      ? { title: "Done", sub: "Your GIF is ready." }
      : { title: "Settings", sub: "Tune it, then record." };

  const status =
    stage === "recording"
      ? { label: "Recording", color: "var(--danger)" }
      : stage === "importing"
      ? { label: "Importing", color: "var(--blue)" }
      : stage === "editing"
      ? { label: "Editing", color: "var(--blue)" }
      : stage === "encoding"
      ? { label: `Rendering ${pct}%`, color: "var(--yellow)" }
      : stage === "done"
      ? { label: "Render complete", color: "var(--green)" }
      : { label: "Ready", color: "var(--green)" };

  return (
    <div className="h-screen overflow-hidden flex flex-col">
      <div className="grid-bg" />
      {/* hidden capture surface */}
      <video ref={videoRef} className="hidden" playsInline muted />
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={onFileInput}
      />

      {/* TOP BAR */}
      <header className="flex items-center justify-between h-16 px-5 border-b-2 theme-border shrink-0">
        <div className="flex items-center gap-2.5">
          <div
            className="w-9 h-9 rounded-lg border-2 theme-border flex items-center justify-center brutal-shadow-sm"
            style={{ background: "var(--green)", color: "#000" }}
          >
            <IconFilm />
          </div>
          <span className="font-display text-lg font-bold tracking-tight">
            Screen → GIF
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="pill hidden sm:inline-flex">
            <IconLock />
            Private · nothing uploaded
          </span>
          <button
            onClick={() => setDark((d) => !d)}
            className="btn btn-white !px-3 !py-2 !text-xs"
            aria-label="Toggle theme"
          >
            {dark ? <IconSun /> : <IconMoon />}
            <span className="hidden sm:inline">{dark ? "Light" : "Dark"}</span>
          </button>
        </div>
      </header>

      {/* MAIN */}
      <main className="flex-1 min-h-0 p-5 md:p-6">
        <div className="h-full grid grid-cols-1 md:grid-cols-[330px_1fr] gap-5 md:gap-6">
          {/* LEFT — CONTROL PANEL */}
          <aside className="card p-5 flex flex-col min-h-0">
            <h2 className="font-display text-base font-bold">{head.title}</h2>
            <p className="text-xs theme-text-muted mb-4">{head.sub}</p>

            <div className="flex flex-col gap-4 flex-1 min-h-0">
              {captureStage && (
                <>
                  <Selector
                    label="Frames per second"
                    value={String(fps)}
                    options={FPS_OPTIONS.map(String)}
                    onChange={(v) => setFps(Number(v))}
                    disabled={busy}
                  />
                  <Selector
                    label="Size"
                    value={SIZE_OPTIONS[sizeIdx].label}
                    options={SIZE_OPTIONS.map((o) => o.label)}
                    onChange={(v) =>
                      setSizeIdx(SIZE_OPTIONS.findIndex((o) => o.label === v))
                    }
                    disabled={busy}
                  />
                  <Selector
                    label="Quality"
                    value={QUALITY_OPTIONS[qualityIdx].label}
                    options={QUALITY_OPTIONS.map((o) => o.label)}
                    onChange={(v) =>
                      setQualityIdx(QUALITY_OPTIONS.findIndex((o) => o.label === v))
                    }
                    disabled={busy}
                  />
                </>
              )}

              {stage === "editing" && (
                <>
                  <Selector
                    label="Speed"
                    value={`${speed}×`}
                    options={SPEED_OPTIONS.map(String)}
                    onChange={(v) => setSpeed(parseFloat(v))}
                  />
                  <Selector
                    label="Quality"
                    value={QUALITY_OPTIONS[qualityIdx].label}
                    options={QUALITY_OPTIONS.map((o) => o.label)}
                    onChange={(v) =>
                      setQualityIdx(QUALITY_OPTIONS.findIndex((o) => o.label === v))
                    }
                  />
                  <div className="rounded-xl border-2 theme-border p-3 text-xs theme-text-muted">
                    Recorded <span className="font-semibold">{recFrames}</span>{" "}
                    frames · {formatDuration(recordingRef.current?.duration ?? 0)}
                  </div>
                </>
              )}
            </div>

            {/* action area — swaps by stage */}
            <div className="mt-4 flex flex-col gap-2.5">
              {stage === "idle" && (
                <>
                  <button
                    onClick={() => void startRecording()}
                    className="btn btn-primary w-full !py-3.5"
                  >
                    <IconRecordDot />
                    Record screen
                  </button>
                  <p className="text-[11px] theme-text-muted text-center">
                    or drop a video on the right →
                  </p>
                </>
              )}

              {stage === "recording" && (
                <button
                  onClick={stopRecording}
                  className="btn btn-danger w-full !py-3.5"
                >
                  <IconStop />
                  Stop &amp; make GIF
                </button>
              )}

              {stage === "importing" && (
                <button disabled className="btn btn-white w-full !py-3.5">
                  Processing…
                </button>
              )}

              {stage === "encoding" && (
                <button disabled className="btn btn-green w-full !py-3.5">
                  Rendering… {pct}%
                </button>
              )}

              {stage === "editing" && (
                <>
                  <button
                    onClick={() => void exportGif()}
                    className="btn btn-primary w-full !py-3.5"
                  >
                    <IconDownload />
                    Export GIF
                  </button>
                  <button
                    onClick={discard}
                    className="btn btn-white w-full !py-2.5 !text-sm"
                  >
                    Discard
                  </button>
                </>
              )}

              {stage === "done" && (
                <>
                  <a
                    href={resultUrl ?? "#"}
                    download="recording.gif"
                    className="btn btn-primary w-full !py-3.5"
                  >
                    <IconDownload />
                    Save .gif
                  </a>
                  <button
                    onClick={() => setStage("editing")}
                    className="btn btn-white w-full !py-2.5 !text-sm"
                  >
                    Edit again
                  </button>
                  <button
                    onClick={discard}
                    className="btn btn-white w-full !py-2.5 !text-sm"
                  >
                    Record another
                  </button>
                </>
              )}
            </div>
          </aside>

          {/* RIGHT — STAGE */}
          <section className="card p-4 flex flex-col min-h-0">
            {error && (
              <div
                className="mb-3 rounded-xl border-2 px-4 py-2.5 text-sm font-semibold shrink-0"
                style={{
                  borderColor: "var(--danger)",
                  color: "var(--danger)",
                  background: "color-mix(in srgb, var(--danger) 10%, transparent)",
                }}
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
                onClick={pickFile}
                className={`drop flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center px-6 cursor-pointer ${
                  dragging ? "is-drag" : ""
                }`}
              >
                <div
                  className="w-14 h-14 rounded-xl border-2 theme-border flex items-center justify-center brutal-shadow-sm"
                  style={{ background: "var(--blue)", color: "#000" }}
                >
                  <IconUpload />
                </div>
                <div className="font-display text-lg font-bold">
                  Drop a video here, or upload one
                </div>
                <div className="text-sm theme-text-muted">MP4, WebM, MOV</div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    pickFile();
                  }}
                  className="btn btn-white !py-2 !px-4 !text-sm mt-1"
                >
                  <IconUpload />
                  Choose file
                </button>
                <div className="text-[11px] theme-text-muted mt-1">
                  or press <Kbd>R</Kbd> to record your screen
                </div>
              </div>
            )}

            {stage === "recording" && (
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 text-center px-6">
                <div className="flex items-center gap-2.5">
                  <span
                    className="w-3 h-3 rounded-full animate-pulse"
                    style={{ background: "var(--danger)" }}
                  />
                  <span className="font-display text-xl font-bold">
                    Recording…
                  </span>
                </div>
                <div className="text-sm theme-text-muted">
                  Capturing your screen — press <Kbd>Esc</Kbd> to stop
                </div>
              </div>
            )}

            {stage === "importing" && (
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 text-center px-6">
                <div className="flex items-center gap-2.5">
                  <span
                    className="w-3 h-3 rounded-full animate-pulse"
                    style={{ background: "var(--blue)" }}
                  />
                  <span className="font-display text-xl font-bold">
                    Reading your video…
                  </span>
                </div>
                <div className="text-sm theme-text-muted">
                  Sampling frames — this only takes a moment.
                </div>
              </div>
            )}

            {stage === "editing" && recordingRef.current && (
              <Editor
                key={recId}
                recording={recordingRef.current}
                trimStart={trimStart}
                trimEnd={trimEnd}
                speed={speed}
                onTrim={(s, e) => {
                  setTrimStart(s);
                  setTrimEnd(e);
                }}
              />
            )}

            {stage === "encoding" && (
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-5 px-8 text-center">
                <div className="font-display text-6xl font-bold tabular-nums">
                  {pct}
                  <span className="text-2xl align-top">%</span>
                </div>
                <div className="bar w-full max-w-sm">
                  <div className="bar__fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="text-sm theme-text-muted">
                  Rendering {frameCount} frames…
                </div>
              </div>
            )}

            {stage === "done" && resultUrl && (
              <div className="flex-1 min-h-0 flex flex-col gap-3">
                <div
                  className="relative flex-1 min-h-0 rounded-xl border-2 theme-border overflow-hidden flex items-center justify-center"
                  style={{ background: "var(--bg)" }}
                >
                  <img
                    src={resultUrl}
                    alt="Your recording as a GIF"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                <div className="grid grid-cols-3 gap-2.5 shrink-0">
                  <Stat label="GIF size" value={formatBytes(resultSize)} />
                  <Stat
                    label="Original"
                    value={sourceSize !== null ? formatBytes(sourceSize) : "—"}
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
        </div>
      </main>

      {/* STATUS BAR */}
      <footer className="h-10 px-5 border-t-2 theme-border flex items-center justify-between shrink-0 text-xs">
        <div className="flex items-center gap-2 theme-text-muted">
          <span>Press</span>
          <Kbd>R</Kbd>
          <span>to record,</span>
          <Kbd>Esc</Kbd>
          <span>to stop</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: status.color }}
          />
          <span className="font-semibold">{status.label}</span>
        </div>
      </footer>
    </div>
  );
}

function Selector({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <span className="block text-sm font-semibold mb-1.5">{label}</span>
      <div className={`seg ${disabled ? "is-disabled" : ""}`} role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            disabled={disabled}
            aria-pressed={o === value}
            onClick={() => onChange(o)}
            className={`seg__opt ${o === value ? "is-active" : ""}`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className="rounded-xl border-2 theme-border p-3"
      style={{ background: accent ? "var(--green)" : "var(--surface)" }}
    >
      <div
        className="text-[11px] font-semibold"
        style={{ color: accent ? "#000" : "var(--text-muted)" }}
      >
        {label}
      </div>
      <div
        className="font-display text-base font-bold tabular-nums"
        style={{ color: accent ? "#000" : "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/* lucide-style inline glyphs (currentColor) */

function IconFilm() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M7 3v18" />
      <path d="M3 7.5h4" />
      <path d="M3 12h18" />
      <path d="M3 16.5h4" />
      <path d="M17 3v18" />
      <path d="M17 7.5h4" />
      <path d="M17 16.5h4" />
    </svg>
  );
}

function IconLock() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function IconRecordDot() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="6" fill="currentColor" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

function IconSun() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}
