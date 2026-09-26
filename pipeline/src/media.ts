import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function hasBinary(bin: string): Promise<boolean> {
  try {
    await run(bin, ["-version"], { timeout: 10_000 });
    return true;
  } catch {
    try {
      await run(bin, ["--version"], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

// Скачивает ролик: сначала по прямой ссылке от провайдера, затем через yt-dlp.
export async function downloadVideo(
  directUrl: string | null,
  pageUrl: string,
  outFile: string,
  maxBytes = 200 * 1024 * 1024,
): Promise<{ ok: boolean; via: "direct" | "yt-dlp" | null; error?: string }> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const errors: string[] = [];
  if (directUrl) {
    try {
      const res = await fetch(directUrl, {
        headers: { "user-agent": UA, referer: pageUrl },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`слишком большой файл: ${buf.length} байт`);
      if (buf.length < 10_000) throw new Error(`подозрительно маленький файл: ${buf.length} байт`);
      fs.writeFileSync(outFile, buf);
      return { ok: true, via: "direct" };
    } catch (e) {
      errors.push(`direct: ${(e as Error).message}`);
    }
  }
  if (await hasBinary("yt-dlp")) {
    try {
      await run(
        "yt-dlp",
        ["-f", "mp4[height<=720]/best[height<=720]/best", "--max-filesize", "200M", "--no-playlist", "-q", "-o", outFile, pageUrl],
        { timeout: 180_000 },
      );
      if (fs.existsSync(outFile)) return { ok: true, via: "yt-dlp" };
      errors.push("yt-dlp: файл не создан");
    } catch (e) {
      errors.push(`yt-dlp: ${firstLine((e as { stderr?: string }).stderr ?? (e as Error).message)}`);
    }
  } else {
    errors.push("yt-dlp не установлен");
  }
  return { ok: false, via: null, error: errors.join("; ") };
}

export async function probeDuration(file: string): Promise<number | null> {
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { timeout: 30_000 },
    );
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

// Моменты для кадров: 0.5 с (хук), 2 с, дальше равномерно до конца.
export function frameTimestamps(duration: number, count: number): number[] {
  if (duration <= 0 || count <= 0) return [];
  const ts = new Set<number>();
  ts.add(Math.min(0.5, duration / 2));
  if (count > 1 && duration > 2.5) ts.add(2);
  const rest = count - ts.size;
  const start = duration > 2.5 ? 3 : 0.5;
  for (let i = 1; i <= rest; i++) {
    const t = start + ((duration - 0.5 - start) * i) / rest;
    if (t > 0 && t < duration) ts.add(Math.round(t * 10) / 10);
  }
  return [...ts].sort((a, b) => a - b).slice(0, count);
}

export interface Frame {
  timeSec: number;
  file: string;
}

export async function extractFrames(videoFile: string, outDir: string, count: number): Promise<Frame[]> {
  const duration = await probeDuration(videoFile);
  if (!duration) return [];
  fs.mkdirSync(outDir, { recursive: true });
  const frames: Frame[] = [];
  for (const t of frameTimestamps(duration, count)) {
    const file = path.join(outDir, `frame_${t.toFixed(1)}s.jpg`);
    try {
      // Масштаб до 540 по короткой стороне: ~700 токенов на кадр у Claude.
      await run(
        "ffmpeg",
        ["-y", "-loglevel", "error", "-threads", "1", "-ss", String(t), "-i", videoFile, "-frames:v", "1",
         "-vf", "scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)'", "-q:v", "4", file],
        { timeout: 60_000 },
      );
      if (fs.existsSync(file)) frames.push({ timeSec: t, file });
    } catch {
      // пропускаем кадр
    }
  }
  return frames;
}

// Звук для распознавания: моно 16 кГц mp3 — маленький файл, достаточно для речи.
export async function extractAudio(inputFile: string, outFile: string): Promise<string | null> {
  try {
    await run(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-threads", "1", "-i", inputFile, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", outFile],
      { timeout: 300_000 },
    );
    return fs.existsSync(outFile) ? outFile : null;
  } catch {
    return null;
  }
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim())?.slice(0, 300) ?? s.slice(0, 300);
}
