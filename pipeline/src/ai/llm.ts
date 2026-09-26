import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { llmCostUsd, type CostTracker } from "../cost.js";

export type ContentBlock = Anthropic.ContentBlockParam;
export type Effort = "low" | "medium" | "high";

export interface LlmRequest<S extends z.ZodType> {
  task: string; // шаг конвейера — для учёта затрат и фикстур
  model: string;
  system: string; // стабильная часть — кэшируется
  context?: string; // общий контекст проекта (бриф) — кэшируется отдельно
  content: ContentBlock[];
  schema: S;
  maxTokens?: number;
  effort?: Effort;
}

export interface LlmClient {
  parse<S extends z.ZodType>(req: LlmRequest<S>): Promise<z.infer<S>>;
}

export class ClaudeClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly cost: CostTracker) {
    this.client = new Anthropic({ apiKey, maxRetries: 3 });
  }

  async parse<S extends z.ZodType>(req: LlmRequest<S>): Promise<z.infer<S>> {
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
    ];
    if (req.context) system.push({ type: "text", text: req.context, cache_control: { type: "ephemeral" } });

    // Haiku 4.5 не поддерживает effort — передаём только для остальных моделей.
    const supportsEffort = !req.model.startsWith("claude-haiku");
    const response = await this.client.messages.parse({
      model: req.model,
      max_tokens: req.maxTokens ?? 16000,
      system,
      messages: [{ role: "user", content: req.content }],
      output_config: {
        format: zodOutputFormat(req.schema),
        ...(supportsEffort && req.effort ? { effort: req.effort } : {}),
      },
    });

    this.cost.record({
      step: req.task,
      provider: "anthropic",
      model: req.model,
      units: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cache_write: response.usage.cache_creation_input_tokens ?? 0,
        cache_read: response.usage.cache_read_input_tokens ?? 0,
      },
      usd: llmCostUsd(req.model, response.usage),
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`${req.task}: модель отказалась отвечать (${response.stop_details?.category ?? "без категории"})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`${req.task}: ответ обрезан по max_tokens`);
    }
    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new Error(`${req.task}: не удалось разобрать структурированный ответ`);
    }
    return response.parsed_output as z.infer<S>;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const LLM_FIXTURES = path.resolve(here, "../../fixtures/mock/llm");

// Заглушка для режима MOCK: отдаёт заранее подготовленные ответы и проверяет их по схеме.
export class StubLlmClient implements LlmClient {
  constructor(private readonly cost: CostTracker) {}

  async parse<S extends z.ZodType>(req: LlmRequest<S>): Promise<z.infer<S>> {
    this.cost.record({ step: req.task, provider: "mock", model: req.model, units: {}, usd: 0 });
    const file = path.join(LLM_FIXTURES, `${req.task}.json`);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return req.schema.parse(data);
  }
}
