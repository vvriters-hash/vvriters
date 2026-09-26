import fs from "node:fs";
import OpenAI from "openai";
import { TRANSCRIBE_USD_PER_MIN, type CostTracker } from "../cost.js";
import { probeDuration } from "../media.js";

export interface Transcriber {
  transcribe(audioFile: string, step: string): Promise<string>;
}

export class OpenAITranscriber implements Transcriber {
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string, private readonly cost: CostTracker) {
    this.client = new OpenAI({ apiKey, maxRetries: 3 });
  }

  async transcribe(audioFile: string, step: string): Promise<string> {
    const seconds = (await probeDuration(audioFile)) ?? 0;
    const res = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: this.model,
    });
    this.cost.record({
      step,
      provider: "openai",
      model: this.model,
      units: { seconds: Math.round(seconds) },
      usd: (seconds / 60) * (TRANSCRIBE_USD_PER_MIN[this.model] ?? 0.006),
    });
    return res.text;
  }
}

export class StubTranscriber implements Transcriber {
  constructor(private readonly cost: CostTracker) {}
  async transcribe(audioFile: string, step: string): Promise<string> {
    this.cost.record({ step, provider: "mock", units: {}, usd: 0 });
    return `[тестовая расшифровка файла ${audioFile}]`;
  }
}
