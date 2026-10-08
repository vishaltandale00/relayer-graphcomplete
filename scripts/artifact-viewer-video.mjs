// Records the artifact-viewer evidence run as a captioned MP4. Frames come from the
// app itself (window plus native artifact view), so nothing else on screen is captured
// and it works with the display asleep. Frames repeat to keep wall-clock timing.
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const FPS = 5;
const WIDTH = 1440;

function escapeXml(text) {
  return text.replace(/[&<>"]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** `frame()` returns a PNG of the current window; `output` is the .mp4 path. */
export function createViewerRecorder({ frame, output, ffmpeg = process.env.RELAYER_EVIDENCE_FFMPEG ?? "/opt/homebrew/bin/ffmpeg" }) {
  const frames = `${output}.frames`;
  let caption = "";
  let index = 0;
  let running = false;
  let loop = null;

  async function captionBar(width) {
    if (!caption) return null;
    const svg = `<svg width="${width}" height="56" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#000" fill-opacity="0.78"/><text x="50%" y="36" text-anchor="middle" fill="#fff" font-family="-apple-system, Helvetica, sans-serif" font-size="22">${escapeXml(caption)}</text></svg>`;
    return Buffer.from(svg);
  }

  async function capture() {
    const image = sharp(await frame()).resize({ width: WIDTH });
    const { data, info } = await image.png().toBuffer({ resolveWithObject: true });
    const bar = await captionBar(info.width);
    return bar ? sharp(data).composite([{ input: bar, left: 0, top: info.height - 56 }]).png().toBuffer() : data;
  }

  return {
    async start() {
      await rm(frames, { recursive: true, force: true });
      await mkdir(frames, { recursive: true });
      running = true;
      loop = (async () => {
        let due = Date.now();
        while (running) {
          let png;
          try { png = await capture(); } catch { png = null; }
          // Hold each frame until the clock catches up, so the video plays in real time.
          due += 1000 / FPS;
          const copies = png ? Math.max(1, Math.round((Date.now() - due) / (1000 / FPS)) + 1) : 0;
          for (let copy = 0; copy < copies; copy += 1) await writeFile(join(frames, `${String(index++).padStart(6, "0")}.png`), png);
          if (copies > 1) due += (copies - 1) * (1000 / FPS);
          await new Promise((done) => setTimeout(done, Math.max(0, due - Date.now())));
        }
      })();
    },
    caption(text) { caption = text; },
    async pause(ms) { await new Promise((done) => setTimeout(done, ms)); },
    async stop() {
      running = false;
      await loop;
      await run(ffmpeg, ["-y", "-framerate", String(FPS), "-i", join(frames, "%06d.png"), "-vf", "fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-movflags", "+faststart", output], { maxBuffer: 8 * 1024 * 1024 });
      await rm(frames, { recursive: true, force: true });
    },
  };
}
