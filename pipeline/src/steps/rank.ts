import { langInstruction, type Ctx } from "../context.js";
import { RelevanceSchema, type Brief, type ScoredVideo, type VideoRef } from "../types.js";
import { median } from "../util/json.js";
import { log } from "../util/log.js";
import { mapLimit } from "../util/pool.js";
import { briefContext } from "./brief.js";
import { videoKey } from "./search.js";

export function engagementRate(v: VideoRef): number | null {
  if (!v.views) return null;
  const sum = (v.likes ?? 0) + (v.comments ?? 0) + (v.shares ?? 0) + (v.saves ?? 0);
  return sum / v.views;
}

// Итоговый балл 0–1: релевантность брифу важнее всего, затем «выброс», затем вовлечённость.
export function finalScore(relevance: number | null, outlier: number | null, er: number | null): number {
  const rel = relevance === null ? 0.5 : Math.max(0, Math.min(10, relevance)) / 10;
  const out = outlier === null ? 0.3 : Math.min(Math.log2(Math.max(outlier, 1)) / Math.log2(10), 1);
  const eng = er === null ? 0.3 : Math.min(er / 0.12, 1);
  return 0.5 * rel + 0.3 * out + 0.2 * eng;
}

const SYSTEM = `Ты оцениваешь, насколько ролики подходят как референсы для брифа. Оценивай по описанию, автору и цифрам.
relevance: 10 — идеально подходит по теме и формату, 5 — смежная тема или переносимый формат, 1 — не подходит. reason — одна короткая фраза.
Верни оценку для каждого ролика по его key.`;

async function scoreRelevance(ctx: Ctx, brief: Brief, videos: VideoRef[]): Promise<Map<string, { relevance: number; reason: string }>> {
  const out = new Map<string, { relevance: number; reason: string }>();
  const chunks: VideoRef[][] = [];
  for (let i = 0; i < videos.length; i += 40) chunks.push(videos.slice(i, i + 40));
  for (const chunk of chunks) {
    const list = chunk.map((v) => ({
      key: videoKey(v),
      author: v.author,
      caption: v.caption.slice(0, 300),
      views: v.views,
      duration_sec: v.durationSec,
    }));
    const res = await ctx.llm.parse({
      task: "relevance",
      model: ctx.cfg.MODEL_FAST,
      system: SYSTEM,
      context: briefContext(brief),
      content: [{ type: "text", text: `Ролики:\n${JSON.stringify(list, null, 1)}\n${langInstruction(ctx.lang)}` }],
      schema: RelevanceSchema,
    });
    for (const it of res.items) out.set(it.key, { relevance: it.relevance, reason: it.reason });
  }
  return out;
}

export async function rankCandidates(
  ctx: Ctx,
  brief: Brief,
  candidates: VideoRef[],
  userAdded: VideoRef[],
  count: number,
): Promise<ScoredVideo[]> {
  // Предварительный отбор по цифрам, чтобы не платить за оценку всего подряд.
  const pre = [...candidates]
    .sort((a, b) => (b.views ?? 0) * (1 + (engagementRate(b) ?? 0)) - (a.views ?? 0) * (1 + (engagementRate(a) ?? 0)))
    .slice(0, Math.max(count * 3, 30));
  log(`Оцениваю релевантность ${pre.length} кандидатов…`);
  const rel = await scoreRelevance(ctx, brief, pre);

  const scored: ScoredVideo[] = pre.map((v) => {
    const r = rel.get(videoKey(v));
    const er = engagementRate(v);
    return {
      ...v,
      er,
      outlier: null,
      relevance: r?.relevance ?? null,
      relevanceReason: r?.reason ?? null,
      userAdded: false,
      score: finalScore(r?.relevance ?? null, null, er),
    };
  });

  // «Выброс» считаем только для лучших кандидатов: это запрос к провайдеру на каждого автора.
  const top = scored.sort((a, b) => b.score - a.score).slice(0, Math.min(ctx.cfg.AUTHOR_BASELINE_TOP, Math.ceil(count * 1.5)));
  log(`Считаю коэффициент выброса для ${top.length} роликов…`);
  const baselineCache = new Map<string, number | null>();
  await mapLimit(top, 3, async (v) => {
    const authorKey = `${v.platform}:${v.author}`;
    if (!baselineCache.has(authorKey)) {
      try {
        const views = await ctx.provider.getAuthorRecentViews(v);
        baselineCache.set(authorKey, median(views.slice(0, 20)));
      } catch {
        baselineCache.set(authorKey, null);
      }
    }
    const base = baselineCache.get(authorKey);
    v.outlier = base && v.views ? v.views / base : null;
    v.score = finalScore(v.relevance, v.outlier, v.er);
  });

  const selected = scored
    .filter((v) => (v.relevance ?? 5) >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, count - userAdded.length));

  const added: ScoredVideo[] = userAdded.map((v) => ({
    ...v,
    er: engagementRate(v),
    outlier: null,
    relevance: null,
    relevanceReason: "добавлен пользователем",
    userAdded: true,
    score: 1,
  }));
  return [...added, ...selected];
}
