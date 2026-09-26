import fs from "node:fs";

// Цены за 1 млн токенов, $ (см. docs/ECONOMICS.md §1.1).
// cacheWrite — запись в кэш (1.25x входа), cacheRead — чтение (0.1x входа).
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

export const TRANSCRIBE_USD_PER_MIN: Record<string, number> = {
  "gpt-4o-mini-transcribe": 0.003,
  "gpt-4o-transcribe": 0.006,
  "whisper-1": 0.006,
};

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function llmCostUsd(model: string, u: LlmUsage): number {
  const p = MODEL_PRICES[model];
  if (!p) return 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  return (
    (u.input_tokens * p.input +
      write * p.input * 1.25 +
      read * p.input * 0.1 +
      u.output_tokens * p.output) /
    1_000_000
  );
}

export interface UsageEvent {
  ts: string;
  step: string;
  provider: "anthropic" | "openai" | "scrapecreators" | "mock";
  model?: string;
  units: Record<string, number>;
  usd: number;
  note?: string;
}

// Аналог UsageEvent из ТЗ §7.4: каждый платный вызов с себестоимостью.
export class CostTracker {
  readonly events: UsageEvent[] = [];
  constructor(private readonly logFile?: string) {}

  record(e: Omit<UsageEvent, "ts">): void {
    const ev = { ts: new Date().toISOString(), ...e };
    this.events.push(ev);
    if (this.logFile) fs.appendFileSync(this.logFile, JSON.stringify(ev) + "\n");
  }

  totalUsd(): number {
    return this.events.reduce((s, e) => s + e.usd, 0);
  }

  byStep(): { step: string; calls: number; usd: number }[] {
    const m = new Map<string, { calls: number; usd: number }>();
    for (const e of this.events) {
      const cur = m.get(e.step) ?? { calls: 0, usd: 0 };
      cur.calls += 1;
      cur.usd += e.usd;
      m.set(e.step, cur);
    }
    return [...m.entries()].map(([step, v]) => ({ step, ...v }));
  }
}
