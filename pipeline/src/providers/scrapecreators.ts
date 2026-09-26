import fs from "node:fs";
import path from "node:path";
import type { CostTracker } from "../cost.js";
import type { CommentSample, Platform, VideoRef } from "../types.js";
import { log } from "../util/log.js";
import type { DataProvider } from "./types.js";
import { detectPlatform } from "./types.js";
import {
  extractComments,
  extractTranscript,
  extractVideoList,
  normalizeAny,
} from "./normalize.js";

const BASE = "https://api.scrapecreators.com";

// Эндпоинты — по документации ScrapeCreators (agent-skills/scrapecreators-api).
const SEARCH: Record<Platform, { keyword: [string, string]; hashtag: [string, string] }> = {
  tiktok: { keyword: ["/v1/tiktok/search/keyword", "query"], hashtag: ["/v1/tiktok/search/hashtag", "hashtag"] },
  instagram: { keyword: ["/v2/instagram/reels/search", "query"], hashtag: ["/v2/instagram/reels/search", "query"] },
  youtube: { keyword: ["/v1/youtube/search", "query"], hashtag: ["/v1/youtube/search/hashtag", "hashtag"] },
};
const DETAILS: Record<Platform, string> = {
  tiktok: "/v2/tiktok/video",
  instagram: "/v1/instagram/post",
  youtube: "/v1/youtube/video",
};
const COMMENTS: Record<Platform, string> = {
  tiktok: "/v1/tiktok/video/comments",
  instagram: "/v2/instagram/post/comments",
  youtube: "/v1/youtube/video/comments",
};
const TRANSCRIPT: Record<Platform, string> = {
  tiktok: "/v1/tiktok/video/transcript",
  instagram: "/v2/instagram/media/transcript",
  youtube: "/v1/youtube/video/transcript",
};
const AUTHOR_VIDEOS: Record<Platform, [string, string]> = {
  tiktok: ["/v3/tiktok/profile/videos", "handle"],
  instagram: ["/v1/instagram/user/reels", "handle"],
  youtube: ["/v1/youtube/channel/shorts", "handle"],
};

export class ScrapeCreatorsProvider implements DataProvider {
  readonly name = "scrapecreators";
  private rawCounter = 0;

  constructor(
    private readonly apiKey: string,
    private readonly cost: CostTracker,
    private readonly usdPerCall: number,
    private readonly rawDir?: string,
  ) {}

  private async call(step: string, endpoint: string, params: Record<string, string>): Promise<unknown> {
    const qs = new URLSearchParams(params);
    const url = `${BASE}${endpoint}?${qs}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { "x-api-key": this.apiKey },
          signal: AbortSignal.timeout(60_000),
        });
        // Кредит списывается за запрос; ошибки 4xx обычно не тарифицируются, но считаем консервативно.
        this.cost.record({
          step,
          provider: "scrapecreators",
          units: { calls: 1 },
          usd: res.ok ? this.usdPerCall : 0,
          note: `${endpoint} ${res.status}`,
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`ScrapeCreators ${endpoint}: HTTP ${res.status}`);
          await sleep(1500 * (attempt + 1));
          continue;
        }
        const body = await res.json().catch(() => null);
        this.saveRaw(endpoint, params, res.status, body);
        if (!res.ok) throw new Error(`ScrapeCreators ${endpoint}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
        return body;
      } catch (e) {
        lastErr = e;
        if (e instanceof Error && e.message.includes("HTTP 4")) break;
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  private saveRaw(endpoint: string, params: Record<string, string>, status: number, body: unknown): void {
    if (!this.rawDir) return;
    fs.mkdirSync(this.rawDir, { recursive: true });
    const name = `${String(++this.rawCounter).padStart(4, "0")}${endpoint.replace(/\//g, "_")}.json`;
    fs.writeFileSync(path.join(this.rawDir, name), JSON.stringify({ endpoint, params, status, body }, null, 2));
  }

  async search(platform: Platform, type: "keyword" | "hashtag", value: string): Promise<VideoRef[]> {
    const [endpoint, param] = SEARCH[platform][type];
    const clean = type === "hashtag" ? value.replace(/^#/, "") : value;
    const params: Record<string, string> = { [param]: clean };
    if (platform === "tiktok" && type === "keyword") {
      params.sort_by = "most-liked";
      params.date_posted = "last-six-months";
    }
    const body = await this.call("search", endpoint, params);
    let list = extractVideoList(platform, body);
    if (platform === "youtube") {
      // В поиск YouTube попадают и длинные видео — оставляем Shorts (≤ 3 мин) и неизвестную длительность.
      list = list.filter((v) => v.durationSec === null || v.durationSec <= 180);
    }
    return list;
  }

  async getVideo(url: string): Promise<VideoRef | null> {
    const platform = detectPlatform(url);
    if (!platform) return null;
    const body = (await this.call("video_details", DETAILS[platform], { url })) as Record<string, unknown>;
    const candidates = [
      body,
      body?.aweme_detail,
      body?.data,
      (body?.data as Record<string, unknown> | undefined)?.xdt_shortcode_media,
    ].filter(Boolean) as Record<string, unknown>[];
    for (const c of candidates) {
      const v = normalizeAny(platform, c);
      if (v) return { ...v, url: v.url || url };
    }
    return null;
  }

  async getComments(video: VideoRef, limit: number): Promise<CommentSample[]> {
    if (limit <= 0) return [];
    const body = await this.call("comments", COMMENTS[video.platform], { url: video.url });
    return extractComments(body, limit);
  }

  async getAuthorRecentViews(video: VideoRef): Promise<number[]> {
    if (!video.author) return [];
    const [endpoint, param] = AUTHOR_VIDEOS[video.platform];
    const body = await this.call("author_baseline", endpoint, { [param]: video.author.replace(/^@/, "") });
    return extractVideoList(video.platform, body)
      .map((v) => v.views)
      .filter((n): n is number => n !== null);
  }

  async getTranscript(video: VideoRef): Promise<string | null> {
    if (video.durationSec !== null && video.durationSec > 120) return null; // провайдер: только до 2 минут
    try {
      const body = await this.call("provider_transcript", TRANSCRIPT[video.platform], { url: video.url });
      return extractTranscript(body);
    } catch (e) {
      log(`  расшифровка провайдера недоступна: ${(e as Error).message}`);
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
