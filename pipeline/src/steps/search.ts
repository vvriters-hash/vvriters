import type { Ctx } from "../context.js";
import type { Strategy, VideoRef } from "../types.js";
import { log } from "../util/log.js";
import { mapLimit } from "../util/pool.js";

export function videoKey(v: Pick<VideoRef, "platform" | "id">): string {
  return `${v.platform}:${v.id}`;
}

export async function runSearch(ctx: Ctx, strategy: Strategy): Promise<VideoRef[]> {
  log(`Ищу ролики: ${strategy.queries.length} запросов…`);
  const lists = await mapLimit(strategy.queries, 3, async (q) => {
    try {
      const found = await ctx.provider.search(q.platform, q.type, q.value);
      log(`  ${q.platform} ${q.type} «${q.value}»: ${found.length}`);
      return found;
    } catch (e) {
      log(`  ${q.platform} «${q.value}»: ошибка — ${(e as Error).message}`);
      return [];
    }
  });
  const byKey = new Map<string, VideoRef>();
  for (const v of lists.flat()) if (!byKey.has(videoKey(v))) byKey.set(videoKey(v), v);
  return [...byKey.values()];
}

// Фильтр по периоду и порогу просмотров; если роликов мало — фильтр ослабляется.
export function filterCandidates(all: VideoRef[], strategy: Strategy, need: number, now = new Date()): VideoRef[] {
  const since = now.getTime() - strategy.period_days * 86_400_000;
  const fresh = (v: VideoRef) => !v.publishedAt || new Date(v.publishedAt).getTime() >= since;
  const strict = all.filter((v) => fresh(v) && (v.views ?? 0) >= strategy.min_views);
  if (strict.length >= need) return strict;
  const relaxed = all.filter((v) => fresh(v) && (v.views ?? 0) >= strategy.min_views / 5);
  if (relaxed.length >= need) return relaxed;
  return all.filter((v) => (v.views ?? 0) > 0);
}
