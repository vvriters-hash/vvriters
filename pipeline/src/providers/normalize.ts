import type { CommentSample, Platform, VideoRef } from "../types.js";
import { findArray, pick, pickNum, pickStr, toIsoDate } from "../util/json.js";

// Нормализация ответов ScrapeCreators. Поля перечислены с запасом:
// точные схемы сверяем по сырым ответам (сохраняются в run/raw) в Фазе 0.

export function normalizeTikTok(raw: Record<string, unknown>): VideoRef | null {
  const v = (raw.aweme_info ?? raw.item ?? raw) as Record<string, unknown>;
  const id = pickStr(v, ["aweme_id", "id", "video_id"]);
  if (!id) return null;
  const author = pickStr(v, ["author.unique_id", "author.uniqueId", "author.nickname", "author_unique_id"]) ?? "";
  const url = pickStr(v, ["share_url", "url"]) ?? `https://www.tiktok.com/@${author}/video/${id}`;
  const durRaw = pickNum(v, ["video.duration", "duration"]);
  return {
    platform: "tiktok",
    id,
    url: url.split("?")[0],
    author,
    authorFollowers: pickNum(v, ["author.follower_count", "authorStats.followerCount", "author_stats.follower_count"]),
    caption: pickStr(v, ["desc", "description", "caption"]) ?? "",
    publishedAt: toIsoDate(pick(v, ["create_time", "createTime"])),
    durationSec: durRaw === null ? null : durRaw > 1000 ? Math.round(durRaw / 1000) : durRaw,
    views: pickNum(v, ["statistics.play_count", "stats.playCount", "play_count", "playCount"]),
    likes: pickNum(v, ["statistics.digg_count", "stats.diggCount", "digg_count", "likes"]),
    comments: pickNum(v, ["statistics.comment_count", "stats.commentCount", "comment_count"]),
    shares: pickNum(v, ["statistics.share_count", "stats.shareCount", "share_count"]),
    saves: pickNum(v, ["statistics.collect_count", "stats.collectCount", "collect_count"]),
    downloadUrl: pickStr(v, [
      "video.play_addr.url_list.0",
      "video.download_addr.url_list.0",
      "video.playAddr",
      "video.downloadAddr",
    ]),
    thumbnailUrl: pickStr(v, ["video.cover.url_list.0", "video.origin_cover.url_list.0", "video.cover"]),
    music: pickStr(v, ["music.title", "music.name"]),
  };
}

export function normalizeInstagram(raw: Record<string, unknown>): VideoRef | null {
  const v = (raw.media ?? raw.node ?? raw.xdt_shortcode_media ?? raw) as Record<string, unknown>;
  const code = pickStr(v, ["code", "shortcode"]);
  const id = code ?? pickStr(v, ["id", "pk"]);
  if (!id) return null;
  return {
    platform: "instagram",
    id,
    url: pickStr(v, ["url", "permalink"]) ?? `https://www.instagram.com/reel/${code ?? id}/`,
    author: pickStr(v, ["owner.username", "user.username", "username"]) ?? "",
    authorFollowers: pickNum(v, ["owner.follower_count", "user.follower_count", "owner.edge_followed_by.count"]),
    caption:
      pickStr(v, ["caption.text", "edge_media_to_caption.edges.0.node.text", "caption", "description"]) ?? "",
    publishedAt: toIsoDate(pick(v, ["taken_at", "taken_at_timestamp", "timestamp"])),
    durationSec: pickNum(v, ["video_duration", "duration"]),
    views: pickNum(v, ["play_count", "video_play_count", "ig_play_count", "video_view_count", "view_count"]),
    likes: pickNum(v, ["like_count", "edge_media_preview_like.count", "edge_liked_by.count"]),
    comments: pickNum(v, ["comment_count", "edge_media_to_comment.count", "edge_media_to_parent_comment.count"]),
    shares: pickNum(v, ["reshare_count", "share_count"]),
    saves: pickNum(v, ["save_count"]),
    downloadUrl: pickStr(v, ["video_url", "video_versions.0.url"]),
    thumbnailUrl: pickStr(v, ["display_url", "thumbnail_src", "image_versions2.candidates.0.url"]),
    music: pickStr(v, ["clips_music_attribution_info.song_name", "music_info.music_asset_info.title"]),
  };
}

export function normalizeYouTube(raw: Record<string, unknown>): VideoRef | null {
  const id = pickStr(raw, ["id", "videoId", "video_id"]);
  if (!id) return null;
  const durStr = pickStr(raw, ["lengthText", "duration"]);
  return {
    platform: "youtube",
    id,
    url: pickStr(raw, ["url"]) ?? `https://www.youtube.com/shorts/${id}`,
    author: pickStr(raw, ["channel.handle", "channel.title", "channel.name", "channelTitle", "author"]) ?? "",
    authorFollowers: pickNum(raw, ["channel.subscriberCount", "channel.subscribers", "subscriberCountInt"]),
    caption: pickStr(raw, ["title", "description"]) ?? "",
    publishedAt: toIsoDate(pick(raw, ["publishDate", "publishedTime", "publishedAt", "uploadDate"])),
    durationSec: pickNum(raw, ["lengthSeconds", "durationMs"]) ?? parseClock(durStr),
    views: pickNum(raw, ["viewCountInt", "viewCount", "views", "viewCountText"]),
    likes: pickNum(raw, ["likeCountInt", "likeCount", "likes"]),
    comments: pickNum(raw, ["commentCountInt", "commentCount", "comments"]),
    shares: null,
    saves: null,
    downloadUrl: null, // для YouTube скачиваем через yt-dlp
    thumbnailUrl: pickStr(raw, ["thumbnail", "thumbnails.0.url"]),
    music: null,
  };
}

function parseClock(s: string | null): number | null {
  if (!s) return null;
  const parts = s.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function normalizeAny(platform: Platform, raw: Record<string, unknown>): VideoRef | null {
  if (platform === "tiktok") return normalizeTikTok(raw);
  if (platform === "instagram") return normalizeInstagram(raw);
  return normalizeYouTube(raw);
}

export function extractVideoList(platform: Platform, body: unknown): VideoRef[] {
  const keys =
    platform === "tiktok"
      ? ["search_item_list", "aweme_list", "videos", "items", "data"]
      : platform === "instagram"
        ? ["reels", "items", "posts", "data.items", "data"]
        : ["shorts", "videos", "items", "contents", "data"];
  const out: VideoRef[] = [];
  for (const item of findArray(body, keys)) {
    const v = normalizeAny(platform, item);
    if (v) out.push(v);
  }
  return out;
}

export function extractComments(body: unknown, limit: number): CommentSample[] {
  return findArray(body, ["comments", "items", "data"])
    .map((c) => ({
      text: pickStr(c, ["text", "content", "comment", "body", "node.text"]) ?? "",
      likes: pickNum(c, ["digg_count", "comment_like_count", "like_count", "likes", "likeCount", "votes"]) ?? 0,
    }))
    .filter((c) => c.text.trim().length > 0)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, limit);
}

export function extractTranscript(body: unknown): string | null {
  const direct = pickStr(body, ["transcript", "text", "transcript_only_text", "data.transcript"]);
  if (direct && direct.length > 3) return direct;
  const segs = findArray(body, ["transcript", "segments", "captions", "data"]);
  const text = segs
    .map((s) => pickStr(s, ["text", "caption", "content"]) ?? "")
    .join(" ")
    .trim();
  return text.length > 3 ? text : null;
}
