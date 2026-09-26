import assert from "node:assert/strict";
import { test } from "node:test";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { CostTracker, llmCostUsd } from "../src/cost.js";
import { frameTimestamps } from "../src/media.js";
import { engagementRate, finalScore } from "../src/steps/rank.js";
import { filterCandidates } from "../src/steps/search.js";
import { BriefSchema, RelevanceSchema, StrategySchema, SynthesisSchema, VideoCardSchema, type VideoRef } from "../src/types.js";

const base: VideoRef = {
  platform: "tiktok", id: "1", url: "u", author: "a", authorFollowers: null, caption: "", publishedAt: null,
  durationSec: 30, views: 1000, likes: 50, comments: 10, shares: 20, saves: 20, downloadUrl: null, thumbnailUrl: null, music: null,
};

test("ER = (лайки+комменты+репосты+сохранения)/просмотры", () => {
  assert.equal(engagementRate(base), 0.1);
  assert.equal(engagementRate({ ...base, views: null }), null);
});

test("finalScore: релевантность важнее выброса", () => {
  const relevantNoOutlier = finalScore(10, 1, 0.05);
  const irrelevantOutlier = finalScore(2, 20, 0.05);
  assert.ok(relevantNoOutlier > irrelevantOutlier);
  assert.ok(finalScore(8, 10, 0.12) <= 1);
});

test("Стоимость вызова Claude с кэшем", () => {
  // Sonnet 5: $2 вход / $10 выход за 1 млн
  const usd = llmCostUsd("claude-sonnet-5", { input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 });
  assert.equal(usd.toFixed(4), (0.02 + 0.02 + 0.004).toFixed(4));
  const t = new CostTracker();
  t.record({ step: "x", provider: "anthropic", units: {}, usd: 0.5 });
  t.record({ step: "x", provider: "anthropic", units: {}, usd: 0.25 });
  assert.equal(t.totalUsd(), 0.75);
  assert.deepEqual(t.byStep(), [{ step: "x", calls: 2, usd: 0.75 }]);
});

test("Кадры: хук в начале, остальные равномерно, в пределах ролика", () => {
  const ts = frameTimestamps(30, 8);
  assert.equal(ts.length, 8);
  assert.equal(ts[0], 0.5);
  assert.equal(ts[1], 2);
  assert.ok(ts.every((t) => t > 0 && t < 30));
  assert.deepEqual([...ts].sort((a, b) => a - b), ts);
  assert.ok(frameTimestamps(2, 8).every((t) => t < 2));
});

test("Фильтр кандидатов ослабляется, если роликов мало", () => {
  const now = new Date("2026-09-20T00:00:00Z");
  const vids: VideoRef[] = [
    { ...base, id: "a", views: 200_000, publishedAt: "2026-09-01T00:00:00Z" },
    { ...base, id: "b", views: 30_000, publishedAt: "2026-09-01T00:00:00Z" },
    { ...base, id: "c", views: 500_000, publishedAt: "2025-01-01T00:00:00Z" },
  ];
  const strat = { search_language: "ru", queries: [], min_views: 100_000, period_days: 90, notes: "" };
  assert.deepEqual(filterCandidates(vids, strat, 1, now).map((v) => v.id), ["a"]);
  assert.deepEqual(filterCandidates(vids, strat, 2, now).map((v) => v.id), ["a", "b"]);
});

test("Все схемы преобразуются в формат структурированного ответа Claude", () => {
  for (const s of [BriefSchema, StrategySchema, RelevanceSchema, VideoCardSchema, SynthesisSchema]) {
    assert.doesNotThrow(() => zodOutputFormat(s));
  }
});
