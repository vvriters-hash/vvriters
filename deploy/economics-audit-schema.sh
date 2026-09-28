#!/usr/bin/env bash
# VVriters Economics — аудит фактической схемы (только чтение).
# Выводит: листы и заголовки Core и Finance, справочники Core, обезличенные счётчики
# (без имён, сумм по людям и реквизитов), расписания Hermes/systemd/cron.
# Запускать на сервере под root, НЕ внутри контейнера. Ничего не меняет.
set -uo pipefail

C="${HERMES:-hermes}"
OUT="/root/economics-audit-schema-$(date +%Y%m%d-%H%M%S).txt"
PY=/opt/data/.hermes/google-workspace-venv/bin/python
U="$(docker exec "$C" stat -c %u:%g /opt/data/skills/vvriters-core/scripts/core_common.py 2>/dev/null || echo 10000:10000)"

{
echo "== Hermes cron (без промптов и адресов)"
docker exec -i -u "$U" "$C" python3 - <<'PY'
import json
for j in json.load(open("/opt/data/cron/jobs.json"))["jobs"]:
    if j.get("enabled"):
        print(f"- {j.get('name')} | {j.get('schedule_display')} | skills={j.get('skills')} | script={j.get('script')} | no_agent={j.get('no_agent')}")
PY
echo
echo "== systemd timers (vvriters/hermes)"
systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'vvriters|hermes' | awk '{print $(NF-1), $NF}'
for u in $(systemctl list-unit-files --no-pager 2>/dev/null | grep -oE 'vvriters-[a-z-]+\.service'); do
  echo "  $u: $(systemctl cat "$u" 2>/dev/null | grep -E '^ExecStart=' | head -1)"
done
echo
echo "== host crontab"
crontab -l 2>/dev/null | grep -vE '^\s*#|^\s*$'
echo

docker exec -i -u "$U" -e PYTHONUNBUFFERED=1 -e PYTHONPATH=/opt/data/skills/vvriters-core/scripts:/opt/data/skills/vvriters-finance/scripts "$C" timeout 600 "$PY" -u - <<'PY'
import re, sys, time
from collections import Counter
sys.path.insert(0, "/opt/data/skills/vvriters-core/scripts")
import core_common as cc
from finance_config import FINANCE_SPREADSHEET_ID

svc = cc.sheets_service()

def ex(req):
    for attempt in range(6):
        try:
            return req.execute(num_retries=3)
        except Exception as e:
            if "429" in str(e) and attempt < 5:
                print("  (лимит Google Sheets, жду 65 с…)", flush=True); time.sleep(65); continue
            raise

def dump_headers(sid, label):
    meta = ex(svc.spreadsheets().get(spreadsheetId=sid, fields="sheets(properties(title,hidden,gridProperties(rowCount,columnCount)))"))
    sheets = [s["properties"] for s in meta.get("sheets", [])]
    titles = [p["title"] for p in sheets]
    vr = ex(svc.spreadsheets().values().batchGet(spreadsheetId=sid, ranges=[f"'{t}'!1:1" for t in titles])).get("valueRanges", [])
    print(f"\n==== {label}: {len(titles)} листов")
    for p, r in zip(sheets, vr):
        head = (r.get("values") or [[]])[0]
        hid = " [hidden]" if p.get("hidden") else ""
        print(f"\n--- {p['title']}{hid}  (сетка {p['gridProperties'].get('rowCount')}×{p['gridProperties'].get('columnCount')}, колонок с заголовком: {len(head)})")
        print("    " + " | ".join(str(h) for h in head))
    return titles

core_titles = dump_headers(cc.SPREADSHEET_ID, "CORE")
fin_titles = dump_headers(FINANCE_SPREADSHEET_ID, "FINANCE")

print("\n==== СПРАВОЧНИКИ Core (значения списков)")
ref = ex(svc.spreadsheets().values().get(spreadsheetId=cc.SPREADSHEET_ID, range="'СПРАВОЧНИКИ'!A1:Z100")).get("values", [])
if ref:
    head = ref[0]
    for i, h in enumerate(head):
        vals = [r[i] for r in ref[1:] if i < len(r) and str(r[i]).strip()]
        col = chr(ord("A") + i)
        print(f"  {col} {h}: {vals}")

def rows(sid, name):
    v = ex(svc.spreadsheets().values().get(spreadsheetId=sid, range=f"'{name}'!A1:ZZ")).get("values", [])
    if not v: return []
    h = [str(x).strip() for x in v[0]]
    return [dict(zip(h, r + [""] * (len(h) - len(r)))) for r in v[1:] if any(str(x).strip() for x in r)]

def cnt(rs, key):
    return dict(Counter(str(r.get(key, "")).strip() or "<пусто>" for r in rs).most_common())

print("\n==== Обезличенные счётчики Core")
pos = rows(cc.SPREADSHEET_ID, "СОСТАВ ПРОЕКТА")
print(f"СОСТАВ ПРОЕКТА: {len(pos)} позиций; по статусу: {cnt(pos,'Статус')}")
print(f"  по статусу оплаты: {cnt(pos,'Статус оплаты')}")
print(f"  без согласованной стоимости: {sum(1 for r in pos if not str(r.get('Согласованная стоимость','')).strip())}")
done = [r for r in pos if str(r.get('Статус','')).strip() == 'Завершена']
print(f"  «Завершена» по месяцу «Дата обновления»: {dict(sorted(Counter(str(r.get('Дата обновления',''))[:7] for r in done).items()))}")
print(f"  «Услуга» (частоты): {cnt(pos,'Услуга')}")

prj = rows(cc.SPREADSHEET_ID, "ПРОЕКТЫ")
print(f"ПРОЕКТЫ: {len(prj)}; по статусу: {cnt(prj,'Статус')}")
for k in ("Расходы учтены полностью", "ID запроса"):
    if prj and k in prj[0]:
        print(f"  {k}: заполнено {sum(1 for r in prj if str(r.get(k,'')).strip())} из {len(prj)}; значения: {cnt(prj,k) if k!='ID запроса' else '—'}")

req = rows(cc.SPREADSHEET_ID, "ЗАПРОСЫ")
print(f"ЗАПРОСЫ: {len(req)}; по статусу: {cnt(req,'Статус')}; по источнику: {cnt(req,'Источник')}")

calls = rows(cc.SPREADSHEET_ID, "СОЗВОНЫ")
tm = [str(r.get("Время", "")).strip() for r in calls]
rng = sum(1 for t in tm if re.search(r"\d{1,2}[:.]\d{2}\s*[-–—]\s*\d{1,2}[:.]\d{2}", t))
print(f"СОЗВОНЫ: {len(calls)}; с заполненным «Время»: {sum(1 for t in tm if t)}; из них с интервалом начало–конец: {rng}")

exp = rows(cc.SPREADSHEET_ID, "РАСХОДЫ ПРОЕКТА")
print(f"РАСХОДЫ ПРОЕКТА: {len(exp)}; с ID позиции: {sum(1 for r in exp if str(r.get('ID позиции','')).strip())}; по типу: {cnt(exp,'Тип расхода')}; по статусу выплаты: {cnt(exp,'Статус выплаты')}")

con = rows(cc.SPREADSHEET_ID, "ИСПОЛНИТЕЛИ")
print(f"ИСПОЛНИТЕЛИ: {len(con)}; по типу: {cnt(con,'Тип исполнителя')}; по статусу: {cnt(con,'Статус') if con and 'Статус' in con[0] else '—'}")

print("\n==== Обезличенные счётчики Finance")
al = rows(FINANCE_SPREADSHEET_ID, "10_РАСПРЕДЕЛЕНИЯ_ПО_ПРОЕКТАМ")
print(f"10_РАСПРЕДЕЛЕНИЯ_ПО_ПРОЕКТАМ: {len(al)}; по TARGET_TYPE: {cnt(al,'TARGET_TYPE')}; по SOURCE: {cnt(al,'SOURCE')}")
ops = rows(FINANCE_SPREADSHEET_ID, "05_ОПЕРАЦИИ")
print(f"05_ОПЕРАЦИИ: {len(ops)}; по FLOW_TYPE: {cnt(ops,'FLOW_TYPE')}")
print(f"  по месяцу EFFECTIVE_AT: {dict(sorted(Counter(str(r.get('EFFECTIVE_AT',''))[:7] for r in ops).items()))}")
print(f"  CATEGORY_STATUS: {cnt(ops,'CATEGORY_STATUS')}; PROJECT_LINK_STATUS: {cnt(ops,'PROJECT_LINK_STATUS')}; BEFORE_GO_LIVE: {cnt(ops,'BEFORE_GO_LIVE')}")
cats = rows(FINANCE_SPREADSHEET_ID, "08_КАТЕГОРИИ")
print(f"08_КАТЕГОРИИ: {[(c.get('CATEGORY_ID'), c.get('NAME'), c.get('DIRECTION')) for c in cats]}")
funds = rows(FINANCE_SPREADSHEET_ID, "02_ПРАВИЛА_ФОНДОВ")
print(f"02_ПРАВИЛА_ФОНДОВ: {[(f.get('FUND_ROLE'), f.get('PERCENT'), f.get('STATUS')) for f in funds]}")
print("\n== Готово")
PY
} 2>&1 | tee "$OUT"
echo
echo "Отчёт сохранён в $OUT — пришли его содержимое."
