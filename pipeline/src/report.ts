import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import type { CostTracker } from "./cost.js";
import type { AnalyzedVideo, Brief, Strategy, Synthesis } from "./types.js";

const n = (v: number | null | undefined) => (v === null || v === undefined ? "н/д" : Math.round(v).toLocaleString("ru-RU"));
const pct = (v: number | null) => (v === null ? "н/д" : `${(v * 100).toFixed(1)}%`);
const x = (v: number | null) => (v === null ? "н/д" : `${v.toFixed(1)}×`);
const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "—");
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export interface ReportInput {
  title: string;
  brief: Brief;
  strategy: Strategy | null;
  analyzed: AnalyzedVideo[];
  synthesis: Synthesis | null;
  cost: CostTracker;
  candidatesFound: number;
  startedAt: Date;
  finishedAt: Date;
}

export function renderMarkdown(r: ReportInput): string {
  const b = r.brief;
  const out: string[] = [];
  out.push(`# ${r.title}`, "");
  out.push(`_Сформировано: ${r.finishedAt.toLocaleString("ru-RU")} · VVriters Studio (прототип)_`, "");

  out.push("## Бриф", "");
  out.push(`- **Ниша:** ${b.core.niche}`);
  out.push(`- **Цель:** ${b.core.goal}`);
  out.push(`- **Аудитория:** ${b.core.audience}`);
  out.push(`- **Язык контента:** ${b.core.content_language}`);
  out.push(`- **Полнота брифа:** ${Math.round(b.completeness_percent)}%`, "");
  if (b.questions.length) {
    out.push("### Уточняющие вопросы клиенту", "");
    const label = { critical: "🔴", important: "🟡", nice: "⚪" } as const;
    b.questions.forEach((q) => out.push(`- ${label[q.priority]} ${q.question} _(${q.why})_`));
    out.push("");
  }

  if (r.synthesis) {
    const s = r.synthesis;
    out.push("## Сводка", "", `**${s.headline}**`, "");
    out.push("### Форматы", "", list(s.patterns.formats), "");
    out.push("### Хуки", "", list(s.patterns.hooks), "");
    out.push("### Длительность", "", s.patterns.durations, "");
    out.push("### Темы", "", list(s.patterns.topics), "");
    out.push("### О чём спрашивают зрители", "", list(s.audience_questions), "");
    out.push("### Незанятые углы", "", list(s.gaps), "");
    out.push("### Рекомендации", "", list(s.recommendations), "");
    out.push("### Направления для роликов", "");
    s.content_directions.forEach((d, i) => out.push(`${i + 1}. **${d.idea}** — ${d.format}. _Основа: ${d.based_on}_`));
    out.push("");
  }

  out.push("## Ролики", "");
  out.push("| # | Площадка | Автор | Просмотры | ER | Выброс | Релевантность | Ссылка |");
  out.push("|---|---|---|---|---|---|---|---|");
  r.analyzed.forEach((a, i) => {
    const v = a.video;
    out.push(`| ${i + 1} | ${v.platform} | @${esc(v.author)} | ${n(v.views)} | ${pct(v.er)} | ${x(v.outlier)} | ${a.card?.relevance_score ?? v.relevance ?? "н/д"} | [открыть](${v.url}) |`);
  });
  out.push("");

  r.analyzed.forEach((a, i) => {
    const v = a.video;
    out.push(`### ${i + 1}. ${v.platform} · @${v.author}${v.userAdded ? " · добавлен вручную" : ""}`, "");
    out.push(`[${v.url}](${v.url})`, "");
    out.push(`Просмотры **${n(v.views)}** · лайки ${n(v.likes)} · комментарии ${n(v.comments)} · репосты ${n(v.shares)} · ER **${pct(v.er)}** · выброс **${x(v.outlier)}** · ${v.durationSec ?? "?"} с`, "");
    if (a.error || !a.card) {
      out.push(`> ⚠️ Разбор не выполнен: ${a.error ?? "нет данных"}`, "");
      return;
    }
    const c = a.card;
    out.push(c.summary, "");
    out.push(`**Хук (${c.hook.type}).** ${c.hook.visual}${c.hook.first_line ? ` — «${c.hook.first_line}»` : ""}${c.hook.on_screen_text ? ` · текст: «${c.hook.on_screen_text}»` : ""}`, "");
    out.push(`**Формат:** ${c.format.type} · темп: ${c.format.pace}${c.format.music ? ` · музыка: ${c.format.music}` : ""}${c.cta ? ` · CTA: ${c.cta}` : ""}`, "");
    if (c.structure.length) {
      out.push("**Структура:**", "");
      c.structure.forEach((s) => out.push(`- ${s.from_sec}–${s.to_sec} с · ${s.segment}: ${s.description}`));
      out.push("");
    }
    out.push("**Почему залетел:**", "");
    c.why_it_worked.forEach((h) => {
      out.push(`- ${h.hypothesis} _(уверенность: ${h.confidence})_`);
      h.evidence.forEach((e) => out.push(`  - ${e.kind}: ${e.value}`));
    });
    out.push("");
    const cm = c.comments;
    out.push(`**Комментарии:** 👍 ${cm.sentiment.positive}% · 😐 ${cm.sentiment.neutral}% · 👎 ${cm.sentiment.negative}%`, "");
    if (cm.viewer_questions.length) out.push("Вопросы зрителей:", "", list(cm.viewer_questions), "");
    if (cm.quotes.length) out.push(...cm.quotes.map((q) => `> ${q}`), "");
    out.push("**Что взять в проект:**", "", list(c.takeaways_for_brief), "");
    out.push(`_Кадров: ${a.framesUsed} · расшифровка: ${a.transcriptSource ?? "нет"} · комментариев в выборке: ${a.commentsSample.length}_`, "");
  });

  out.push("## Себестоимость прогона (служебное)", "");
  out.push("| Шаг | Вызовов | $ |", "|---|---|---|");
  r.cost.byStep().forEach((s) => out.push(`| ${s.step} | ${s.calls} | ${s.usd.toFixed(4)} |`));
  const ok = r.analyzed.filter((a) => a.card).length;
  out.push(`| **Итого** | | **${r.cost.totalUsd().toFixed(3)}** |`, "");
  out.push(
    `Найдено кандидатов: ${r.candidatesFound} · разобрано: ${ok}/${r.analyzed.length} · время: ${Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000)} с` +
      (ok ? ` · $ на ролик: ${(r.cost.totalUsd() / ok).toFixed(3)}` : ""),
  );
  if (r.strategy) {
    out.push("", "<details><summary>Стратегия поиска</summary>", "");
    r.strategy.queries.forEach((q) => out.push(`- ${q.platform} · ${q.type} · «${q.value}» — ${q.rationale}`));
    out.push("", "</details>");
  }
  return out.join("\n");
}

const CSS = `
:root{--bg:#010101;--panel:#0e0e0e;--text:#f5f5f5;--muted:#9a9a9a;--accent:#00bcd4;--border:#2a2a2a}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--panel:#fff;--text:#111;--muted:#555;--accent:#00838f;--border:#ddd}}
body{background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,Segoe UI,Arial,sans-serif;margin:0}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}
h1{border-bottom:2px solid var(--accent);padding-bottom:12px}
h2{color:var(--accent);border-left:4px solid var(--accent);padding-left:12px;margin-top:40px}
h3{margin-top:28px}
a{color:var(--accent)}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;font-size:14px}
th,td{border:1px solid var(--border);padding:6px 8px;text-align:left}
blockquote{border-left:3px solid var(--border);margin:8px 0;padding:2px 12px;color:var(--muted)}
em{color:var(--muted)}
`;

export function writeReports(runDir: string, r: ReportInput): { md: string; html: string } {
  const md = renderMarkdown(r);
  const mdFile = path.join(runDir, "report.md");
  fs.writeFileSync(mdFile, md);
  const body = marked.parse(md, { async: false }) as string;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${r.title.replace(/</g, "&lt;")}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
  const htmlFile = path.join(runDir, "report.html");
  fs.writeFileSync(htmlFile, html);
  return { md: mdFile, html: htmlFile };
}
