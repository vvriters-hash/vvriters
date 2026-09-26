import { z } from "zod";

// Все настройки — из переменных окружения (файл .env на сервере).
const Env = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  SCRAPECREATORS_API_KEY: z.string().optional(),

  // Модели. По умолчанию — как в ТЗ/ECONOMICS: Sonnet 5 для выводов и текста,
  // Haiku 4.5 для массовых простых задач. Меняются без правки кода.
  MODEL_MAIN: z.string().default("claude-sonnet-5"),
  MODEL_FAST: z.string().default("claude-haiku-4-5"),
  MODEL_VIDEO: z.string().default("claude-sonnet-5"),
  TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),

  // Стоимость запроса к ScrapeCreators в $ (пакет $47 / 25k = 0.00188).
  SCRAPECREATORS_USD_PER_CALL: z.coerce.number().default(0.00188),

  DATA_DIR: z.string().default("./data"),
  VIDEO_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  FRAMES_PER_VIDEO: z.coerce.number().int().min(1).max(16).default(8),
  MAX_COMMENTS: z.coerce.number().int().min(0).default(150),
  AUTHOR_BASELINE_TOP: z.coerce.number().int().min(0).default(20),

  // MOCK=1 — работать на тестовых данных из fixtures/mock без ключей и сети.
  MOCK: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}

export function missingKeys(cfg: Config): string[] {
  if (cfg.MOCK) return [];
  const missing: string[] = [];
  if (!cfg.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!cfg.SCRAPECREATORS_API_KEY) missing.push("SCRAPECREATORS_API_KEY");
  return missing;
}
