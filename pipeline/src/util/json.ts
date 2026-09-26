// Ответы провайдеров данных различаются по площадкам и версиям API.
// Эти помощники достают поле по нескольким возможным путям.

export type Json = unknown;

export function getPath(obj: Json, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(key)) cur = cur[Number(key)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur;
}

export function pick(obj: Json, paths: string[]): unknown {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function pickStr(obj: Json, paths: string[]): string | null {
  const v = pick(obj, paths);
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

export function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.trim().replace(/[\s,]/g, "");
    const m = s.match(/^(\d+(?:\.\d+)?)([kKmMbB])?$/);
    if (m) {
      const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase() as "k" | "m" | "b"] ?? 1;
      return Math.round(parseFloat(m[1]) * mult);
    }
  }
  return null;
}

export function pickNum(obj: Json, paths: string[]): number | null {
  for (const p of paths) {
    const n = toNum(getPath(obj, p));
    if (n !== null) return n;
  }
  return null;
}

// Находит первый непустой массив объектов по списку ключей, затем — поиском в глубину.
export function findArray(obj: Json, preferredKeys: string[], depth = 3): Record<string, unknown>[] {
  if (Array.isArray(obj)) return obj.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  if (!obj || typeof obj !== "object") return [];
  for (const k of preferredKeys) {
    const v = getPath(obj, k);
    if (Array.isArray(v) && v.length > 0) return v as Record<string, unknown>[];
  }
  if (depth <= 0) return [];
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") return v as Record<string, unknown>[];
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = findArray(v, preferredKeys, depth - 1);
      if (found.length) return found;
    }
  }
  return [];
}

export function toIsoDate(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const n = toNum(v);
  if (n !== null) {
    const ms = n < 1e12 ? n * 1000 : n; // секунды или миллисекунды
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function median(nums: number[]): number | null {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
