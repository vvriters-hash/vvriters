import { z } from "zod";

export const PLATFORMS = ["tiktok", "instagram", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];

// Нормализованный ролик — одинаковый для всех площадок.
export interface VideoRef {
  platform: Platform;
  id: string;
  url: string;
  author: string;
  authorFollowers: number | null;
  caption: string;
  publishedAt: string | null; // ISO
  durationSec: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  downloadUrl: string | null;
  thumbnailUrl: string | null;
  music: string | null;
}

export interface CommentSample {
  text: string;
  likes: number;
}

export interface ScoredVideo extends VideoRef {
  er: number | null; // (лайки+комменты+репосты+сохранения)/просмотры
  outlier: number | null; // просмотры / медиана просмотров автора
  relevance: number | null; // 1–10 от ИИ
  relevanceReason: string | null;
  userAdded: boolean;
  score: number;
}

// ---------- Схемы ответов ИИ (структурированный вывод) ----------

export const BriefSchema = z.object({
  client: z.object({
    brand: z.string().nullable(),
    product: z.string().nullable(),
    niche: z.string().nullable(),
    competitors: z.array(z.string()),
  }),
  goal: z.object({
    primary: z.string().nullable(),
    kpi: z.string().nullable(),
    key_message: z.string().nullable(),
    cta: z.string().nullable(),
  }),
  audience: z.object({
    portrait: z.string().nullable(),
    language: z.string().nullable(),
    geo: z.string().nullable(),
  }),
  format: z.object({
    platforms: z.array(z.string()),
    videos_count: z.number().nullable(),
    duration_sec: z.number().nullable(),
    rubrics: z.array(z.string()),
  }),
  style: z.object({
    tone: z.string().nullable(),
    likes: z.array(z.string()),
    dislikes: z.array(z.string()),
  }),
  production: z.string().nullable(),
  constraints: z.object({
    forbidden: z.array(z.string()),
    mandatory: z.array(z.string()),
  }),
  deadlines: z.string().nullable(),
  core: z.object({
    niche: z.string(),
    goal: z.string(),
    audience: z.string(),
    content_language: z.string(),
  }),
  completeness_percent: z.number(),
  questions: z.array(
    z.object({
      question: z.string(),
      why: z.string(),
      priority: z.enum(["critical", "important", "nice"]),
    }),
  ),
});
export type Brief = z.infer<typeof BriefSchema>;

export const StrategySchema = z.object({
  search_language: z.string(),
  queries: z.array(
    z.object({
      platform: z.enum(PLATFORMS),
      type: z.enum(["keyword", "hashtag"]),
      value: z.string(),
      rationale: z.string(),
    }),
  ),
  min_views: z.number(),
  period_days: z.number(),
  notes: z.string(),
});
export type Strategy = z.infer<typeof StrategySchema>;

export const RelevanceSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      relevance: z.number(),
      reason: z.string(),
    }),
  ),
});

export const VideoCardSchema = z.object({
  summary: z.string(),
  hook: z.object({
    visual: z.string(),
    on_screen_text: z.string().nullable(),
    first_line: z.string().nullable(),
    type: z.string(),
  }),
  structure: z.array(
    z.object({
      from_sec: z.number(),
      to_sec: z.number(),
      segment: z.string(),
      description: z.string(),
    }),
  ),
  format: z.object({
    type: z.string(),
    pace: z.string(),
    subtitles: z.boolean().nullable(),
    graphics: z.string().nullable(),
    music: z.string().nullable(),
  }),
  cta: z.string().nullable(),
  comments: z.object({
    sentiment: z.object({ positive: z.number(), neutral: z.number(), negative: z.number() }),
    themes: z.array(z.string()),
    viewer_questions: z.array(z.string()),
    objections: z.array(z.string()),
    quotes: z.array(z.string()),
  }),
  why_it_worked: z.array(
    z.object({
      hypothesis: z.string(),
      confidence: z.enum(["low", "medium", "high"]),
      evidence: z.array(
        z.object({
          kind: z.enum(["timecode", "metric", "comment", "frame"]),
          value: z.string(),
        }),
      ),
    }),
  ),
  takeaways_for_brief: z.array(z.string()),
  relevance_score: z.number(),
});
export type VideoCard = z.infer<typeof VideoCardSchema>;

export const SynthesisSchema = z.object({
  headline: z.string(),
  patterns: z.object({
    formats: z.array(z.string()),
    hooks: z.array(z.string()),
    durations: z.string(),
    topics: z.array(z.string()),
  }),
  audience_questions: z.array(z.string()),
  gaps: z.array(z.string()),
  recommendations: z.array(z.string()),
  content_directions: z.array(
    z.object({ idea: z.string(), format: z.string(), based_on: z.string() }),
  ),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;

export interface AnalyzedVideo {
  video: ScoredVideo;
  transcript: string | null;
  transcriptSource: "own" | "provider" | null;
  commentsSample: CommentSample[];
  framesUsed: number;
  card: VideoCard | null;
  error: string | null;
}
