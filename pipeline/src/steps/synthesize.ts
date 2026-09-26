import { langInstruction, type Ctx } from "../context.js";
import { SynthesisSchema, type AnalyzedVideo, type Brief, type Synthesis } from "../types.js";
import { log } from "../util/log.js";
import { briefContext } from "./brief.js";

const SYSTEM = `Ты — креативный продюсер. По разборам роликов-референсов сделай сводную аналитику для креатора и его клиента.
- patterns — закономерности, которые повторяются у нескольких роликов (укажи, у скольких).
- audience_questions — о чём зрители спрашивают и спорят: это готовые темы для контента.
- gaps — незанятые углы: о чём спрашивают, но почти не снимают.
- recommendations — конкретные рекомендации по формату, хуку, длительности для проекта из брифа.
- content_directions — 5–8 направлений для роликов; в based_on — на какие ролики или инсайты опирается.
Без банальностей, только то, что следует из разборов.`;

export async function synthesize(ctx: Ctx, brief: Brief, analyzed: AnalyzedVideo[]): Promise<Synthesis> {
  const cards = analyzed
    .filter((a) => a.card)
    .map((a) => ({
      video: `${a.video.platform} @${a.video.author} ${a.video.url}`,
      views: a.video.views,
      er: a.video.er,
      outlier: a.video.outlier,
      card: a.card,
    }));
  log(`Собираю сводку по ${cards.length} разборам…`);
  return ctx.llm.parse({
    task: "synthesis",
    model: ctx.cfg.MODEL_MAIN,
    system: SYSTEM,
    context: briefContext(brief),
    content: [{ type: "text", text: `Разборы:\n${JSON.stringify(cards)}\n\n${langInstruction(ctx.lang)}` }],
    schema: SynthesisSchema,
    effort: "high",
  });
}
