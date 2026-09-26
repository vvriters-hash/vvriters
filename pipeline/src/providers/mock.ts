import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CostTracker } from "../cost.js";
import type { CommentSample, Platform, VideoRef } from "../types.js";
import type { DataProvider } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// И из src/ (tsx), и из dist/ фикстуры лежат в ../fixtures/mock.
const FIXTURES = path.resolve(here, "../../fixtures/mock");

interface MockData {
  videos: VideoRef[];
  comments: Record<string, CommentSample[]>;
  authorViews: Record<string, number[]>;
  transcripts: Record<string, string>;
}

// Провайдер на тестовых данных — для проверки конвейера без ключей и сети.
export class MockProvider implements DataProvider {
  readonly name = "mock";
  private readonly data: MockData;

  constructor(private readonly cost: CostTracker) {
    this.data = JSON.parse(fs.readFileSync(path.join(FIXTURES, "provider.json"), "utf8"));
  }

  private tick(step: string): void {
    this.cost.record({ step, provider: "mock", units: { calls: 1 }, usd: 0 });
  }

  async search(platform: Platform): Promise<VideoRef[]> {
    this.tick("search");
    return this.data.videos.filter((v) => v.platform === platform);
  }
  async getVideo(url: string): Promise<VideoRef | null> {
    this.tick("video_details");
    return this.data.videos.find((v) => v.url === url) ?? null;
  }
  async getComments(video: VideoRef, limit: number): Promise<CommentSample[]> {
    this.tick("comments");
    return (this.data.comments[video.id] ?? []).slice(0, limit);
  }
  async getAuthorRecentViews(video: VideoRef): Promise<number[]> {
    this.tick("author_baseline");
    return this.data.authorViews[video.author] ?? [];
  }
  async getTranscript(video: VideoRef): Promise<string | null> {
    this.tick("provider_transcript");
    return this.data.transcripts[video.id] ?? null;
  }
}
