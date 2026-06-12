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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const samplerRef = useRef<Sampler | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

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

  return (
    <div className="min-h-screen">
      <div className="ios-bg" />
      {/* hidden capture surface */}
      <video ref={videoRef} className="hidden" playsInline muted />

      <div className="mx-auto flex min-h-screen max-w-lg flex-col px-5 py-12">
        <header className="mb-9">
          <div className="flex items-center gap-4">
            <div className="app-icon">
              <IconScreenRecord />
            </div>
            <h1 className="large-title">Screen to GIF</h1>
          </div>
          <p className="subtitle">
            Record your screen or drop in a video — it becomes a GIF right on
            your device. Nothing is uploaded.
          </p>
        </header>

        {/* settings */}
        <section className="ios-card p-5">
          <Segmented
            label="Frame rate"
            value={String(fps)}
            options={FPS_OPTIONS.map(String)}
            onChange={(v) => setFps(Number(v))}
            disabled={busy}
          />
          <Segmented
            label="Size"
            value={SIZE_OPTIONS[sizeIdx].label}
            options={SIZE_OPTIONS.map((o) => o.label)}
            onChange={(v) =>
              setSizeIdx(SIZE_OPTIONS.findIndex((o) => o.label === v))
            }
            disabled={busy}
          />
          <Segmented
            label="Quality"
            value={QUALITY_OPTIONS[qualityIdx].label}
            options={QUALITY_OPTIONS.map((o) => o.label)}
            onChange={(v) =>
              setQualityIdx(QUALITY_OPTIONS.findIndex((o) => o.label === v))
            }
            disabled={busy}
          />
        </section>

        {/* main action area */}
        <div className="mt-6 flex-1">
          {stage === "idle" && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`ios-card stagecard stagecard--drop stage-anim flex flex-col items-center justify-center gap-5 px-6 text-center ${
                dragging ? "is-drag" : ""
              }`}
            >
              <button
                onClick={() => void startRecording()}
                className="ios-btn ios-btn--blue"
              >
                <IconRecord />
                Start recording
              </button>
              <p className="t-secondary text-sm">
                or drop a video file to convert
              </p>
              <p className="t-tertiary text-xs">
                Press <Kbd>R</Kbd> to record · <Kbd>Esc</Kbd> to stop
              </p>
            </div>
          )}

          {stage === "recording" && (
            <div className="ios-card stagecard stage-anim flex flex-col items-center justify-center gap-5 px-6 text-center">
              <div className="flex items-center gap-3 text-[17px] font-semibold">
                <span className="rec-dot" />
                Recording…
              </div>
              <button onClick={stopRecording} className="ios-btn ios-btn--red">
                <IconStop />
                Stop &amp; make GIF
              </button>
              <p className="t-tertiary text-xs">
                or press <Kbd>Esc</Kbd>
              </p>
            </div>
          )}

          {stage === "encoding" && (
            <div className="ios-card stagecard stage-anim flex flex-col items-center justify-center gap-4 px-10 text-center">
              <p className="text-[17px] font-semibold">Creating GIF…</p>
              <div className="ios-progress w-full max-w-sm">
                <div
                  className="ios-progress__fill"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <p className="t-secondary text-sm tnum">
                {Math.round(progress * 100)}% · {frameCount} frames
              </p>
            </div>
          )}

          {stage === "done" && resultUrl && (
            <div className="ios-card stage-anim p-4">
              <img
                src={resultUrl}
                alt="Your recording as a GIF"
                className="mx-auto max-h-80 rounded-xl"
              />
              <div className="ios-list mt-4">
                <div className="ios-list__row">
                  <span className="k">GIF size</span>
                  <span className="v">{formatBytes(resultSize)}</span>
                </div>
                {sourceSize !== null && (
                  <div className="ios-list__row">
                    <span className="k">Original</span>
                    <span className="v">{formatBytes(sourceSize)}</span>
                  </div>
                )}
                {savings !== null && savings > 0 && (
                  <div className="ios-list__row">
                    <span className="k">Saved</span>
                    <span className="v green">{savings}% smaller</span>
                  </div>
                )}
              </div>
              <div className="mt-4 flex flex-col gap-2">
                <a
                  href={resultUrl}
                  download="recording.gif"
                  className="ios-btn ios-btn--blue ios-btn--full"
                >
                  <IconDownload />
                  Save GIF
                </a>
                <button
                  onClick={() => {
                    resetResult();
                    setStage("idle");
                  }}
                  className="ios-btn ios-btn--plain ios-btn--full"
                >
                  Record another
                </button>
              </div>
            </div>
          )}

          {error && <p className="ios-note mt-4">{error}</p>}
        </div>

        <footer className="t-secondary mt-10 text-center text-xs">
          100% client-side · your recording never leaves your device
        </footer>
      </div>
    </div>
  );
}

function Segmented({
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
  const idx = Math.max(0, options.indexOf(value));
  return (
    <div className="setting">
      <span className="setting__label">{label}</span>
      <div
        className={`ios-seg ${disabled ? "is-disabled" : ""}`}
        role="group"
        aria-label={label}
      >
        <span
          className="ios-seg__thumb"
          style={{
            width: `calc((100% - 4px) / ${options.length})`,
            transform: `translateX(${idx * 100}%)`,
          }}
        />
        {options.map((o) => (
          <button
            key={o}
            type="button"
            disabled={disabled}
            aria-pressed={o === value}
            onClick={() => onChange(o)}
            className={`ios-seg__opt ${o === value ? "is-active" : ""}`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="ios-kbd">{children}</kbd>;
}

/* SF Symbols–style glyphs (currentColor, rounded strokes) */

function IconScreenRecord() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="3.2"
        y="5"
        width="17.6"
        height="13"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <circle cx="12" cy="11.5" r="3.1" fill="currentColor" />
    </svg>
  );
}

function IconRecord() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="5" fill="currentColor" />
      <circle
        cx="12"
        cy="12"
        r="8.4"
        stroke="currentColor"
        strokeWidth="1.6"
        opacity="0.9"
      />
    </svg>
  );
}

function IconStop() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.6" fill="currentColor" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v9" />
      <path d="M8.5 10.5 12 14l3.5-3.5" />
      <path d="M5 15v2.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V15" />
    </svg>
  );
}
