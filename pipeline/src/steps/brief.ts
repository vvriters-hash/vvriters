import fs from "node:fs";
import path from "node:path";
import type { ContentBlock } from "../ai/llm.js";
import { langInstruction, type Ctx } from "../context.js";
import { extractAudio } from "../media.js";
import { BriefSchema, type Brief } from "../types.js";
import { log } from "../util/log.js";

const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json"]);
const AUDIO_VIDEO_EXT = new Set([".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".webm", ".mp4", ".mov", ".aac", ".flac"]);
const IMAGE_EXT: Record<string, "image/jpeg" | "image/png" | "image/webp" | "image/gif"> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
};

const SYSTEM = `Ты — опытный продюсер и сценарист коротких видео (Reels, TikTok, YouTube Shorts), который работает с клиентами на заказ.
Твоя задача — разобрать материалы от клиента (тексты, документы, расшифровки голосовых, скриншоты) и заполнить бриф.

Правила:
- Заполняй поле только тем, что есть в материалах или прямо из них следует. Не выдумывай. Если данных нет — null или пустой список.
- core — ядро запроса для поиска референсов: ниша, цель, аудитория, язык контента (язык, на котором говорит аудитория). Здесь допустимы разумные выводы из контекста.
- completeness_percent — насколько бриф готов для работы (0–100).
- questions — уточняющие вопросы клиенту, которых не хватает для хорошего результата. Сначала critical (цель, ЦА, площадка, формат), потом important, потом nice. Не спрашивай то, что уже есть. Максимум 8 вопросов. Формулируй вежливо и конкретно, так, чтобы креатор мог переслать вопрос клиенту как есть.`;

// Материалы брифа → блоки для Claude. Аудио и видео расшифровываются.
export async function buildBriefContent(ctx: Ctx, files: string[], extraText?: string): Promise<{ blocks: ContentBlock[]; transcripts: Record<string, string> }> {
  const blocks: ContentBlock[] = [];
  const transcripts: Record<string, string> = {};
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const name = path.basename(file);
    if (TEXT_EXT.has(ext)) {
      blocks.push({ type: "text", text: `Файл «${name}»:\n${fs.readFileSync(file, "utf8")}` });
    } else if (ext === ".pdf") {
      blocks.push({
        type: "document",
        title: name,
        source: { type: "base64", media_type: "application/pdf", data: fs.readFileSync(file).toString("base64") },
      });
    } else if (IMAGE_EXT[ext]) {
      blocks.push({ type: "text", text: `Изображение «${name}»:` });
      blocks.push({ type: "image", source: { type: "base64", media_type: IMAGE_EXT[ext], data: fs.readFileSync(file).toString("base64") } });
    } else if (AUDIO_VIDEO_EXT.has(ext)) {
      if (!ctx.transcriber) throw new Error(`Для расшифровки «${name}» нужен OPENAI_API_KEY`);
      log(`Расшифровываю «${name}»…`);
      let audio = file;
      if (ctx.hasFfmpeg) {
        const out = path.join(ctx.runDir, "tmp", `${name}.mp3`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        audio = (await extractAudio(file, out)) ?? file;
      }
      const text = await ctx.transcriber.transcribe(audio, "brief_transcribe");
      transcripts[name] = text;
      blocks.push({ type: "text", text: `Расшифровка аудио/видео «${name}»:\n${text}` });
    } else {
      log(`Пропускаю «${name}»: формат пока не поддерживается (DOCX → сохраните как PDF)`);
    }
  }
  if (extraText) blocks.push({ type: "text", text: `Комментарий креатора:\n${extraText}` });
  return { blocks, transcripts };
}

export async function parseBrief(ctx: Ctx, files: string[], extraText?: string): Promise<{ brief: Brief; transcripts: Record<string, string> }> {
  const { blocks, transcripts } = await buildBriefContent(ctx, files, extraText);
  if (!blocks.length) throw new Error("Нет материалов брифа");
  blocks.push({ type: "text", text: `Заполни бриф по этим материалам. ${langInstruction(ctx.lang)}` });
  log("Разбираю бриф…");
  const brief = await ctx.llm.parse({
    task: "brief",
    model: ctx.cfg.MODEL_MAIN,
    system: SYSTEM,
    content: blocks,
    schema: BriefSchema,
    effort: "medium",
  });
  return { brief, transcripts };
}

// Краткий контекст брифа для следующих шагов (кэшируется в промпте).
export function briefContext(brief: Brief): string {
  return `БРИФ ПРОЕКТА (JSON):\n${JSON.stringify(brief, null, 2)}`;
}
