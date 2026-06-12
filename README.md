# Screen → GIF

A fast, private, **100% client-side** screen recorder and video-to-GIF converter. Record your screen (or drop in a video file) and it becomes an optimized GIF right in your browser — nothing is ever uploaded to a server.

🔗 **Live demo:** _add your GitHub Pages URL here after deploying_

## Features

- 🎬 **Record your screen** or a single window via the browser's native capture
- 📥 **Drag-and-drop a video** (mp4, webm, mov…) to convert it to a GIF
- ⚙️ **FPS, size, and quality presets** to trade off smoothness vs. file size
- 📉 **Before/after size** when converting, so you can see how much was saved
- ⌨️ **Keyboard shortcuts** — <kbd>R</kbd> to record, <kbd>Esc</kbd> to stop
- 🔒 **Fully client-side** — your recording never leaves your device
- ⚡ **Non-blocking encoding** in a Web Worker, so the UI stays smooth

## How it works

Both paths — live recording and dropped files — feed the same pipeline:

1. **Capture frames.** A live screen stream (`getDisplayMedia`) or a playing video file is drawn to an off-screen `<canvas>` at the chosen frame rate, scaling each frame down to the selected size. This yields a sequence of raw RGBA frames.
2. **Encode off the main thread.** The frames are transferred (zero-copy) to a **Web Worker** running [`gifenc`](https://github.com/mattdesl/gifenc), a fast modern GIF encoder. Each frame is colour-quantized to a palette and written to the GIF, with progress reported back to the UI.
3. **Download.** The finished GIF comes back as a `Blob` and is shown for preview and one-click download. No network requests are involved at any step.

## Performance & privacy notes

- **Why a Web Worker:** GIF encoding is CPU-heavy. Running it on the main thread would freeze the page; doing it in a worker keeps the interface responsive and the progress bar live. Frames are passed as **transferable** `ArrayBuffer`s, so there's no expensive copy between threads.
- **Why `gifenc`:** it's a small, fast, dependency-free encoder with good quantization — a modern alternative to older libraries, and it runs cleanly inside a worker with no special server headers.
- **Why it's free to host:** the entire app is static files with no backend. That's also the privacy guarantee — there is no server to upload to, so your screen contents stay on your machine.
- **Size control:** frames are downscaled at capture time and the palette size is configurable, so you can tune output from crisp to tiny.

## Tech stack

React · TypeScript · Vite · Tailwind CSS v4 · `gifenc` · Web Workers · Canvas API · `getDisplayMedia`

## Run locally

```bash
npm install
npm run dev
```

Open the printed URL. Building:

```bash
npm run build      # type-checks and bundles to dist/
npm run preview    # serve the production build locally
```

## Deploy (free)

The repo includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds the app and deploys it to **GitHub Pages** on every push to `main`. After the first push, enable Pages once: repository **Settings → Pages → Source → GitHub Actions**. Because Vite is configured with a relative `base`, it works under a project subpath without extra config. It deploys just as easily to Cloudflare Pages or Vercel.

## Roadmap

This is the lightweight first version. Planned next:

- **FFmpeg.wasm** engine for smaller GIFs and **MP4 / WebM export**
- **Trim** and **crop** before export
- **Webcam overlay** (screen + camera bubble)

## Limitations (honest notes)

- Screen capture requires a browser that supports `getDisplayMedia` (Chrome, Edge, Firefox, Safari) and works on desktop, not mobile.
- Very long or high-resolution recordings are bounded by available memory, since frames are held in memory before encoding — use a smaller size/FPS for long captures.
- File conversion plays the video through in real time to sample frames, so a long clip takes about its own duration to convert. (The FFmpeg.wasm engine on the roadmap will make this faster.)

## License

MIT — see [LICENSE](LICENSE). Free to use, modify, and build on.
