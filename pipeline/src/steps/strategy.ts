import { langInstruction, type Ctx } from "../context.js";
import { StrategySchema, type Brief, type Platform, type Strategy } from "../types.js";
import { briefContext } from "./brief.js";
import { log } from "../util/log.js";

const SYSTEM = `Ты — исследователь контента коротких видео. По брифу составь стратегию поиска референсов — топовых роликов, на которые стоит опереться.

Правила:
- Запросы — на языке аудитории (search_language), так, как люди реально ищут и подписывают ролики в этой нише. Добавь 1–2 англоязычных запроса, если ниша международная.
- Для каждой площадки 3–4 запроса: ключевые слова (тема, боль, формат) и хэштеги. Смежные ниши допустимы, если форматы оттуда переносимы.
- Хэштеги — без символа #.
- min_views: порог просмотров. Широкая ниша — около 100000, узкая — около 20000.
- period_days: 90 по умолчанию; 180–365 для медленных ниш.
- В notes — коротко, какие форматы ищем и почему.`;

export async function planSearch(ctx: Ctx, brief: Brief, platforms: Platform[]): Promise<Strategy> {
  log("Составляю стратегию поиска…");
  const strategy = await ctx.llm.parse({
    task: "strategy",
    model: ctx.cfg.MODEL_MAIN,
    system: SYSTEM,
    context: briefContext(brief),
    content: [
      {
        type: "text",
        text: `Площадки: ${platforms.join(", ")}. Составь запросы только для них. ${langInstruction(ctx.lang)}`,
      },
    ],
    schema: StrategySchema,
    effort: "medium",
  });
  strategy.queries = strategy.queries.filter((q) => platforms.includes(q.platform));
  return strategy;
}
