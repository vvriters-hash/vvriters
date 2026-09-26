import assert from "node:assert/strict";
import { test } from "node:test";
import { extractComments, extractTranscript, extractVideoList, normalizeInstagram, normalizeTikTok, normalizeYouTube } from "../src/providers/normalize.js";
import { median, toNum } from "../src/util/json.js";

test("toNum понимает числа, строки и сокращения", () => {
  assert.equal(toNum(1200), 1200);
  assert.equal(toNum("1,234"), 1234);
  assert.equal(toNum("1.2M"), 1_200_000);
  assert.equal(toNum("15K"), 15_000);
  assert.equal(toNum("abc"), null);
});

test("median", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("TikTok: результат поиска с aweme_info", () => {
  const body = {
    search_item_list: [
      {
        aweme_info: {
          aweme_id: "7251387037834595630",
          desc: "кофе #тбилиси",
          create_time: 1726000000,
          author: { unique_id: "coffee.tbilisi", follower_count: 45000 },
          statistics: { play_count: 1200000, digg_count: 98000, comment_count: 2100, share_count: 5400, collect_count: 8800 },
          video: { duration: 28000, play_addr: { url_list: ["https://cdn.example/v.mp4"] } },
          music: { title: "original sound" },
        },
      },
    ],
  };
  const [v] = extractVideoList("tiktok", body);
  assert.equal(v.id, "7251387037834595630");
  assert.equal(v.url, "https://www.tiktok.com/@coffee.tbilisi/video/7251387037834595630");
  assert.equal(v.views, 1_200_000);
  assert.equal(v.saves, 8800);
  assert.equal(v.durationSec, 28);
  assert.equal(v.downloadUrl, "https://cdn.example/v.mp4");
  assert.equal(v.publishedAt, new Date(1726000000 * 1000).toISOString());
});

test("TikTok: без id — пропускается", () => {
  assert.equal(normalizeTikTok({ desc: "нет id" }), null);
});

test("Instagram: reel", () => {
  const v = normalizeInstagram({
    code: "DOq6eV6iIgD",
    owner: { username: "specialty.ge" },
    caption: { text: "Почему капучино стоит 12 лари" },
    taken_at: 1726000000,
    play_count: 880000,
    like_count: 52000,
    comment_count: 1300,
    video_url: "https://cdn.example/ig.mp4",
    video_duration: 18.4,
  });
  assert.ok(v);
  assert.equal(v.url, "https://www.instagram.com/reel/DOq6eV6iIgD/");
  assert.equal(v.author, "specialty.ge");
  assert.equal(v.views, 880000);
  assert.equal(v.downloadUrl, "https://cdn.example/ig.mp4");
});

test("YouTube: short с текстовой длительностью", () => {
  const v = normalizeYouTube({ id: "abc123", title: "Latte art", viewCountInt: 2300000, lengthText: "0:31", channel: { handle: "CoffeeLab" } });
  assert.ok(v);
  assert.equal(v.durationSec, 31);
  assert.equal(v.url, "https://www.youtube.com/shorts/abc123");
  assert.equal(v.downloadUrl, null);
});

test("Комментарии: сортировка по лайкам и лимит", () => {
  const body = { comments: [{ text: "a", digg_count: 1 }, { text: "b", digg_count: 10 }, { text: "", digg_count: 99 }, { text: "c", digg_count: 5 }] };
  const c = extractComments(body, 2);
  assert.deepEqual(c.map((x) => x.text), ["b", "c"]);
});

test("Расшифровка: строка или сегменты", () => {
  assert.equal(extractTranscript({ transcript: "привет мир" }), "привет мир");
  assert.equal(extractTranscript({ transcript: [{ text: "привет" }, { text: "мир" }] }), "привет мир");
  assert.equal(extractTranscript({}), null);
});
