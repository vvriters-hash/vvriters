import type { LlmClient } from "./ai/llm.js";
import type { Transcriber } from "./ai/transcribe.js";
import type { Config } from "./config.js";
import type { CostTracker } from "./cost.js";
import type { DataProvider } from "./providers/types.js";

export interface Ctx {
  cfg: Config;
  cost: CostTracker;
  provider: DataProvider;
  llm: LlmClient;
  transcriber: Transcriber | null;
  runDir: string;
  lang: string; // язык результатов: ru | en | es
  hasFfmpeg: boolean;
}

export const LANG_NAMES: Record<string, string> = { ru: "русский", en: "English", es: "español" };

export function langInstruction(lang: string): string {
  return `Язык всех текстовых полей ответа: ${LANG_NAMES[lang] ?? lang}. Цитаты из роликов и комментариев оставляй на языке оригинала.`;
}
