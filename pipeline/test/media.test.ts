import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { extractAudio, extractFrames, hasBinary, probeDuration } from "../src/media.js";

test("ffmpeg: кадры и звук из вертикального ролика", async (t) => {
  if (!(await hasBinary("ffmpeg"))) return t.skip("ffmpeg не установлен");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-media-"));
  const video = path.join(dir, "v.mp4");
  // 12 с, 720x1280, тестовая картинка + тон 440 Гц
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=720x1280:rate=25:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
  const dur = await probeDuration(video);
  assert.ok(dur && Math.abs(dur - 12) < 0.5);
  const frames = await extractFrames(video, path.join(dir, "frames"), 6);
  assert.equal(frames.length, 6);
  const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", frames[0].file]).toString().trim();
  assert.equal(probe, "540,960"); // короткая сторона 540
  const audio = await extractAudio(video, path.join(dir, "a.mp3"));
  assert.ok(audio && fs.statSync(audio).size > 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});
