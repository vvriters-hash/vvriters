import type { CommentSample, Platform, VideoRef } from "../types.js";

// Слой-абстракция из ТЗ §7.2: провайдеры подключаются адаптерами.
export interface DataProvider {
  readonly name: string;
  search(platform: Platform, type: "keyword" | "hashtag", value: string): Promise<VideoRef[]>;
  getVideo(url: string): Promise<VideoRef | null>;
  getComments(video: VideoRef, limit: number): Promise<CommentSample[]>;
  getAuthorRecentViews(video: VideoRef): Promise<number[]>;
  getTranscript(video: VideoRef): Promise<string | null>;
}

export function detectPlatform(url: string): Platform | null {
  const u = url.toLowerCase();
  if (u.includes("tiktok.com")) return "tiktok";
  if (u.includes("instagram.com")) return "instagram";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  return null;
}
