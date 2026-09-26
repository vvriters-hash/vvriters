#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ClaudeClient, StubLlmClient } from "./ai/llm.js";
import { OpenAITranscriber, StubTranscriber } from "./ai/transcribe.js";
import { loadConfig, missingKeys } from "./config.js";
import type { Ctx } from "./context.js";
import { CostTracker } from "./cost.js";
import { hasBinary } from "./media.js";
import { MockProvider } from "./providers/mock.js";
import { ScrapeCreatorsProvider } from "./providers/scrapecreators.js";
import { detectPlatform } from "./providers/types.js";
import { writeReports } from "./report.js";
import { analyzeVideos } from "./steps/analyze.js";
import { parseBrief } from "./steps/brief.js";
import { rankCandidates } from "./steps/rank.js";
import { filterCandidates, runSearch } from "./steps/search.js";
import { planSearch } from "./steps/strategy.js";
import { synthesize } from "./steps/synthesize.js";
import { PLATFORMS, type Brief, type Platform, type VideoRef } from "./types.js";
import { log } from "./util/log.js";

const HELP = `VVriters Studio — прототип конвейера аналитики (Фаза 0)

Команды:
  run          Бриф → стратегия → поиск → отбор → разбор роликов → сводка → отчёт
               --brief <файл>      материалы брифа (можно несколько): .txt .md .pdf, фото, голосовые/видео
               --text "<текст>"    бриф текстом прямо в команде
               --count <N>         сколько роликов разобрать (по умолчанию 10)
               --platforms <список> tiktok,instagram,youtube (по умолчанию все)
               --link <url>        свой ролик, обязательно разобрать (можно несколько)
               --lang ru|en|es     язык результатов (по умолчанию ru)
               --name <имя>        название прогона

  analyze-url  Разбор одного ролика по ссылке (бесплатный разбор из COMPETITORS §6)
               <url> [--brief <файл>] [--text "<текст>"] [--lang ru]

  check        Проверить настройки, ключи и ffmpeg/yt-dlp

Переменные окружения — см. .env.example. MOCK=1 — тестовый режим без ключей.`;

async function makeCtx(name: string, lang: string): Promise<Ctx> {
  const cfg = loadConfig();
  const missing = missingKeys(cfg);
  if (missing.length) throw new Error(`Не заданы ключи: ${missing.join(", ")} (или запустите с MOCK=1)`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = name.toLowerCase().replace(/[^a-zа-я0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "run";
  const runDir = path.resolve(cfg.DATA_DIR, "runs", `${stamp}_${slug}`);
  fs.mkdirSync(runDir, { recursive: true });
  const cost = new CostTracker(path.join(runDir, "costs.jsonl"));
  const provider = cfg.MOCK
    ? new MockProvider(cost)
    : new ScrapeCreatorsProvider(cfg.SCRAPECREATORS_API_KEY!, cost, cfg.SCRAPECREATORS_USD_PER_CALL, path.join(runDir, "raw"));
  const llm = cfg.MOCK ? new StubLlmClient(cost) : new ClaudeClient(cfg.ANTHROPIC_API_KEY!, cost);
  const transcriber = cfg.MOCK
    ? new StubTranscriber(cost)
    : cfg.OPENAI_API_KEY
      ? new OpenAITranscriber(cfg.OPENAI_API_KEY, cfg.TRANSCRIBE_MODEL, cost)
      : null;
  const hasFfmpeg = (await hasBinary("ffmpeg")) && (await hasBinary("ffprobe"));
  if (!hasFfmpeg) log("⚠️ ffmpeg не найден — кадры и звук из роликов извлекаться не будут");
  if (!transcriber) log("⚠️ OPENAI_API_KEY не задан — расшифровка только от провайдера данных");
  log(`Папка прогона: ${runDir}`);
  return { cfg, cost, provider, llm, transcriber, runDir, lang, hasFfmpeg };
}

function save(ctx: Ctx, file: string, data: unknown): void {
  fs.writeFileSync(path.join(ctx.runDir, file), JSON.stringify(data, null, 2));
}

async function loadLinks(ctx: Ctx, links: string[]): Promise<VideoRef[]> {
  const out: VideoRef[] = [];
  for (const url of links) {
    if (!detectPlatform(url)) {
      log(`Пропускаю ссылку (площадка не поддерживается): ${url}`);
      continue;
    }
    try {
      const v = await ctx.provider.getVideo(url);
      if (v) out.push(v);
      else log(`Ролик не найден: ${url}`);
    } catch (e) {
      log(`Ошибка по ссылке ${url}: ${(e as Error).message}`);
    }
  }
  return out;
}

async function cmdRun(values: Record<string, string | string[] | boolean | undefined>): Promise<void> {
  const briefs = (values.brief as string[] | undefined) ?? [];
  const text = values.text as string | undefined;
  if (!briefs.length && !text) throw new Error("Нужен --brief <файл> или --text \"…\"");
  const count = Math.max(1, Math.min(30, parseInt((values.count as string) ?? "10", 10)));
  const platforms = ((values.platforms as string) ?? PLATFORMS.join(","))
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
  const lang = (values.lang as string) ?? "ru";
  const ctx = await makeCtx((values.name as string) ?? path.basename(briefs[0] ?? "brief"), lang);
  const startedAt = new Date();

  const { brief, transcripts } = await parseBrief(ctx, briefs, text);
  save(ctx, "brief.json", { brief, transcripts });
  const strategy = await planSearch(ctx, brief, platforms);
  save(ctx, "strategy.json", strategy);
  const found = await runSearch(ctx, strategy);
  const candidates = filterCandidates(found, strategy, count);
  const userAdded = await loadLinks(ctx, (values.link as string[] | undefined) ?? []);
  const selected = await rankCandidates(ctx, brief, candidates, userAdded, count);
  save(ctx, "selected.json", selected);
  const analyzed = await analyzeVideos(ctx, brief, selected);
  save(ctx, "videos.json", analyzed);
  const synthesis = analyzed.some((a) => a.card) ? await synthesize(ctx, brief, analyzed) : null;
  save(ctx, "synthesis.json", synthesis);

  const title = (values.name as string) ?? `Референсы: ${brief.core.niche}`;
  const files = writeReports(ctx.runDir, {
    title, brief, strategy, analyzed, synthesis, cost: ctx.cost,
    candidatesFound: found.length, startedAt, finishedAt: new Date(),
  });
  printSummary(ctx, files.html, analyzed.filter((a) => a.card).length, analyzed.length, startedAt);
}

async function cmdAnalyzeUrl(url: string | undefined, values: Record<string, string | string[] | boolean | undefined>): Promise<void> {
  if (!url) throw new Error("Укажите ссылку: analyze-url <url>");
  const lang = (values.lang as string) ?? "ru";
  const ctx = await makeCtx(`url-${detectPlatform(url) ?? "video"}`, lang);
  const startedAt = new Date();
  const briefs = (values.brief as string[] | undefined) ?? [];
  const text = (values.text as string | undefined) ?? (briefs.length ? undefined : "Бриф не задан: оцени ролик как референс для креатора в целом.");
  const { brief } = await parseBrief(ctx, briefs, text);
  const [video] = await loadLinks(ctx, [url]);
  if (!video) throw new Error("Не удалось получить данные ролика");
  const selected = await rankCandidates(ctx, brief, [], [video], 1);
  const baseline = await ctx.provider.getAuthorRecentViews(video).catch(() => []);
  const { median } = await import("./util/json.js");
  const m = median(baseline.slice(0, 20));
  if (m && video.views) selected[0].outlier = video.views / m;
  const analyzed = await analyzeVideos(ctx, brief, selected);
  save(ctx, "videos.json", analyzed);
  const files = writeReports(ctx.runDir, {
    title: `Разбор ролика @${video.author}`, brief: brief as Brief, strategy: null, analyzed, synthesis: null,
    cost: ctx.cost, candidatesFound: 1, startedAt, finishedAt: new Date(),
  });
  printSummary(ctx, files.html, analyzed.filter((a) => a.card).length, 1, startedAt);
}

function printSummary(ctx: Ctx, html: string, ok: number, total: number, startedAt: Date): void {
  const sec = Math.round((Date.now() - startedAt.getTime()) / 1000);
  console.log("\n=== Готово ===");
  console.log(`Разобрано: ${ok}/${total} · время: ${Math.floor(sec / 60)} мин ${sec % 60} с`);
  console.log(`Себестоимость: $${ctx.cost.totalUsd().toFixed(3)}${ok ? ` ($${(ctx.cost.totalUsd() / ok).toFixed(3)} на ролик)` : ""}`);
  for (const s of ctx.cost.byStep()) console.log(`  ${s.step.padEnd(20)} ${String(s.calls).padStart(4)} выз.  $${s.usd.toFixed(4)}`);
  console.log(`Отчёт: ${html}`);
}

async function cmdCheck(): Promise<void> {
  const cfg = loadConfig();
  const mark = (ok: boolean) => (ok ? "✔" : "✘");
  console.log(`Режим: ${cfg.MOCK ? "MOCK (тестовые данные)" : "боевой"}`);
  console.log(`${mark(!!cfg.ANTHROPIC_API_KEY)} ANTHROPIC_API_KEY   модели: main=${cfg.MODEL_MAIN}, fast=${cfg.MODEL_FAST}, video=${cfg.MODEL_VIDEO}`);
  console.log(`${mark(!!cfg.OPENAI_API_KEY)} OPENAI_API_KEY      расшифровка: ${cfg.TRANSCRIBE_MODEL}`);
  console.log(`${mark(!!cfg.SCRAPECREATORS_API_KEY)} SCRAPECREATORS_API_KEY`);
  console.log(`${mark(await hasBinary("ffmpeg"))} ffmpeg   ${mark(await hasBinary("yt-dlp"))} yt-dlp`);
  if (cfg.SCRAPECREATORS_API_KEY && !cfg.MOCK) {
    try {
      const res = await fetch("https://api.scrapecreators.com/v1/credit/balance", {
        headers: { "x-api-key": cfg.SCRAPECREATORS_API_KEY },
        signal: AbortSignal.timeout(20_000),
      });
      console.log(`ScrapeCreators баланс: HTTP ${res.status} ${JSON.stringify(await res.json().catch(() => null))}`);
    } catch (e) {
      console.log(`ScrapeCreators: ошибка ${(e as Error).message}`);
    }
  }
  console.log(`Данные: ${path.resolve(cfg.DATA_DIR)}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      brief: { type: "string", multiple: true },
      text: { type: "string" },
      count: { type: "string" },
      platforms: { type: "string" },
      link: { type: "string", multiple: true },
      lang: { type: "string" },
      name: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || !cmd) {
    console.log(HELP);
    return;
  }
  if (cmd === "run") return cmdRun(values);
  if (cmd === "analyze-url") return cmdAnalyzeUrl(arg, values);
  if (cmd === "check") return cmdCheck();
  throw new Error(`Неизвестная команда: ${cmd}\n\n${HELP}`);
}

main().catch((e) => {
  console.error(`\nОшибка: ${(e as Error).message}`);
  process.exit(1);
});
