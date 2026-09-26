import fs from "node:fs";
import path from "node:path";
import type { ContentBlock } from "../ai/llm.js";
import { langInstruction, type Ctx } from "../context.js";
import { downloadVideo, extractAudio, extractFrames, type Frame } from "../media.js";
import { VideoCardSchema, type AnalyzedVideo, type Brief, type CommentSample, type ScoredVideo } from "../types.js";
import { log } from "../util/log.js";
import { mapLimit } from "../util/pool.js";
import { briefContext } from "./brief.js";

const SYSTEM = `Ты — аналитик коротких видео и сценарист. Разбираешь ролик-референс для креатора, который делает видео на заказ.
На входе: цифры ролика, кадры с таймкодами, расшифровка речи, описание, топ комментариев.

Правила:
- Опирайся только на то, что видно в кадрах, слышно в расшифровке и есть в цифрах и комментариях. Не выдумывай.
- Каждая гипотеза в why_it_worked обязана иметь доказательства: таймкод («0:01 — …»), цифру (ER, выброс, просмотры) или цитату из комментария. Без доказательств гипотезу не пиши.
- Банальности («качественный контент», «интересная тема») запрещены — только конкретные приёмы.
- hook — первые 1–3 секунды: что в кадре, текст на экране, первая фраза, тип хука (вопрос, провокация, результат в начале, POV, «до/после», обещание и т. п.).
- structure — сегменты с таймкодами в секундах.
- comments.sentiment — доли в процентах (сумма 100). viewer_questions — реальные вопросы зрителей из комментариев. quotes — 2–4 показательные цитаты дословно.
- takeaways_for_brief — что конкретно взять в проект из брифа.
- relevance_score — 1–10, насколько ролик полезен для брифа.
- Если кадров нет (не удалось скачать), анализируй по расшифровке, описанию и комментариям и прямо укажи это в summary.`;

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function metricsText(v: ScoredVideo): string {
  const f = (n: number | null) => (n === null ? "н/д" : n.toLocaleString("ru-RU"));
  return [
    `Площадка: ${v.platform}; автор: @${v.author}; подписчиков: ${f(v.authorFollowers)}`,
    `Ссылка: ${v.url}`,
    `Дата: ${v.publishedAt ?? "н/д"}; длительность: ${v.durationSec ?? "н/д"} с; звук: ${v.music ?? "н/д"}`,
    `Просмотры: ${f(v.views)}; лайки: ${f(v.likes)}; комментарии: ${f(v.comments)}; репосты: ${f(v.shares)}; сохранения: ${f(v.saves)}`,
    `ER: ${v.er === null ? "н/д" : (v.er * 100).toFixed(1) + "%"}; коэффициент выброса (просмотры / медиана автора): ${v.outlier === null ? "н/д" : v.outlier.toFixed(1) + "x"}`,
    `Описание: ${v.caption || "—"}`,
  ].join("\n");
}

async function analyzeOne(ctx: Ctx, brief: Brief, video: ScoredVideo, index: number, total: number): Promise<AnalyzedVideo> {
  const tag = `[${index + 1}/${total}] ${video.platform} @${video.author}`;
  const dir = path.join(ctx.runDir, "videos", `${video.platform}_${video.id}`);
  fs.mkdirSync(dir, { recursive: true });
  const result: AnalyzedVideo = {
    video,
    transcript: null,
    transcriptSource: null,
    commentsSample: [],
    framesUsed: 0,
    card: null,
    error: null,
  };
  try {
    // Детали ролика — если в поиске не было ссылки на файл (кроме YouTube: там yt-dlp).
    if (!video.downloadUrl && video.platform !== "youtube") {
      try {
        const d = await ctx.provider.getVideo(video.url);
        if (d?.downloadUrl) video.downloadUrl = d.downloadUrl;
        if (d && video.durationSec === null) video.durationSec = d.durationSec;
      } catch (e) {
        log(`${tag}: детали не получены — ${(e as Error).message}`);
      }
    }

    let comments: CommentSample[] = [];
    try {
      comments = await ctx.provider.getComments(video, ctx.cfg.MAX_COMMENTS);
    } catch (e) {
      log(`${tag}: комментарии не получены — ${(e as Error).message}`);
    }
    result.commentsSample = comments;

    let frames: Frame[] = [];
    if (ctx.hasFfmpeg && !ctx.cfg.MOCK) {
      const videoFile = path.join(dir, "video.mp4");
      const dl = await downloadVideo(video.downloadUrl, video.url, videoFile);
      if (dl.ok) {
        frames = await extractFrames(videoFile, path.join(dir, "frames"), ctx.cfg.FRAMES_PER_VIDEO);
        if (ctx.transcriber) {
          const audio = await extractAudio(videoFile, path.join(dir, "audio.mp3"));
          if (audio) {
            try {
              result.transcript = await ctx.transcriber.transcribe(audio, "video_transcribe");
              result.transcriptSource = "own";
            } catch (e) {
              log(`${tag}: своя расшифровка не удалась — ${(e as Error).message}`);
            }
            fs.rmSync(audio, { force: true });
          }
        }
        // Видео после анализа не храним (ТЗ §6): остаются кадры и аналитика.
        fs.rmSync(videoFile, { force: true });
      } else {
        log(`${tag}: видео не скачано — ${dl.error}`);
      }
    }
    if (!result.transcript) {
      result.transcript = await ctx.provider.getTranscript(video);
      if (result.transcript) result.transcriptSource = "provider";
    }
    result.framesUsed = frames.length;

    const content: ContentBlock[] = [{ type: "text", text: `ЦИФРЫ И ОПИСАНИЕ\n${metricsText(video)}` }];
    for (const fr of frames) {
      content.push({ type: "text", text: `Кадр ${fmtTime(fr.timeSec)}:` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(fr.file).toString("base64") },
      });
    }
    content.push({ type: "text", text: `РАСШИФРОВКА РЕЧИ\n${result.transcript ?? "нет (речь не распознана или ролик без слов)"}` });
    content.push({
      type: "text",
      text: `КОММЕНТАРИИ (топ по лайкам, ${comments.length} шт.)\n${
        comments.map((c) => `[${c.likes}] ${c.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") || "нет"
      }`,
    });
    content.push({ type: "text", text: `Сделай карточку разбора ролика. ${langInstruction(ctx.lang)}` });

    log(`${tag}: анализ (кадров: ${frames.length}, расшифровка: ${result.transcriptSource ?? "нет"}, комментариев: ${comments.length})`);
    result.card = await ctx.llm.parse({
      task: "video_analysis",
      model: ctx.cfg.MODEL_VIDEO,
      system: SYSTEM,
      context: briefContext(brief),
      content,
      schema: VideoCardSchema,
      effort: "medium",
    });
  } catch (e) {
    result.error = (e as Error).message;
    log(`${tag}: ошибка — ${result.error}`);
  }
  return result;
}

export async function analyzeVideos(ctx: Ctx, brief: Brief, videos: ScoredVideo[]): Promise<AnalyzedVideo[]> {
  log(`Разбираю ${videos.length} роликов (параллельно: ${ctx.cfg.VIDEO_CONCURRENCY})…`);
  return mapLimit(videos, ctx.cfg.VIDEO_CONCURRENCY, (v, i) => analyzeOne(ctx, brief, v, i, videos.length));
}
