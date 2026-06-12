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
    <div className="min-h-full text-neutral-100">
      {/* hidden capture surface */}
      <video ref={videoRef} className="hidden" playsInline muted />

      <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-5 py-10">
        <header className="mb-10">
          <div className="flex items-center gap-2 text-sm font-medium text-neutral-400">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" />
            Recording
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Screen to GIF, in your browser
          </h1>
          <p className="mt-2 text-neutral-400">
            Record your screen or drop in a video. It becomes a GIF on your
            machine — nothing is uploaded.
          </p>
        </header>

        {/* settings */}
        <div className="grid grid-cols-3 gap-3">
          <Selector
            label="FPS"
            value={String(fps)}
            options={FPS_OPTIONS.map(String)}
            onChange={(v) => setFps(Number(v))}
            disabled={busy}
          />
          <Selector
            label="Size"
            value={SIZE_OPTIONS[sizeIdx].label}
            options={SIZE_OPTIONS.map((o) => o.label)}
            onChange={(v) => setSizeIdx(SIZE_OPTIONS.findIndex((o) => o.label === v))}
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
        </div>

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
              className={`flex h-72 flex-col items-center justify-center rounded-2xl border-2 border-dashed transition ${
                dragging
                  ? "border-emerald-400 bg-emerald-400/5"
                  : "border-neutral-800 bg-neutral-900/40"
              }`}
            >
              <button
                onClick={() => void startRecording()}
                className="rounded-xl bg-emerald-500 px-6 py-3 font-semibold text-emerald-950 transition hover:bg-emerald-400"
              >
                Start recording
              </button>
              <p className="mt-4 text-sm text-neutral-500">
                or drop a video file to convert
              </p>
              <p className="mt-6 text-xs text-neutral-600">
                Press <Kbd>R</Kbd> to record · <Kbd>Esc</Kbd> to stop
              </p>
            </div>
          )}

          {stage === "recording" && (
            <div className="flex h-72 flex-col items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-900/40">
              <div className="flex items-center gap-3 text-lg font-medium">
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
                </span>
                Capturing…
              </div>
              <button
                onClick={stopRecording}
                className="mt-6 rounded-xl bg-neutral-100 px-6 py-3 font-semibold text-neutral-900 transition hover:bg-white"
              >
                Stop &amp; make GIF
              </button>
              <p className="mt-4 text-xs text-neutral-600">
                or press <Kbd>Esc</Kbd>
              </p>
            </div>
          )}

          {stage === "encoding" && (
            <div className="flex h-72 flex-col items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-900/40 px-10">
              <p className="font-medium">Encoding GIF…</p>
              <div className="mt-4 h-2 w-full max-w-sm overflow-hidden rounded-full bg-neutral-800">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-[width] duration-150"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <p className="mt-3 text-sm text-neutral-500">
                {Math.round(progress * 100)}% · {frameCount} frames
              </p>
            </div>
          )}

          {stage === "done" && resultUrl && (
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
              <img
                src={resultUrl}
                alt="Your recording as a GIF"
                className="mx-auto max-h-80 rounded-lg"
              />
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-neutral-400">
                  <span className="font-medium text-neutral-100">
                    {formatBytes(resultSize)}
                  </span>{" "}
                  GIF
                  {sourceSize !== null && (
                    <>
                      {" · from "}
                      {formatBytes(sourceSize)}
                      {savings !== null && savings > 0 && (
                        <span className="ml-1 text-emerald-400">
                          ({savings}% smaller)
                        </span>
                      )}
                    </>
                  )}
                </div>
                <div className="flex gap-2">
                  <a
                    href={resultUrl}
                    download="recording.gif"
                    className="rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400"
                  >
                    Download GIF
                  </a>
                  <button
                    onClick={() => {
                      resetResult();
                      setStage("idle");
                    }}
                    className="rounded-xl border border-neutral-700 px-5 py-2.5 text-sm font-medium text-neutral-200 transition hover:bg-neutral-800"
                  >
                    New
                  </button>
                </div>
              </div>
            </div>
          )}

          {error && (
            <p className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
              {error}
            </p>
          )}
        </div>

        <footer className="mt-10 text-center text-xs text-neutral-600">
          100% client-side · your recording never leaves your device
        </footer>
      </div>
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
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none transition focus:border-neutral-600 disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 font-mono text-[0.7rem] text-neutral-300">
      {children}
    </kbd>
  );
}
