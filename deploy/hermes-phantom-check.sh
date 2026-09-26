#!/usr/bin/env bash
# Только чтение. Показывает, как Finance исключает авторизацию из сверки PENDING_EXPECTED
# (на примере SPEKTRA) и в каком состоянии фантомная авторизация KHAMOVNIKI 5 880 ₽.
# Запускать на сервере под root, НЕ внутри контейнера.
set -uo pipefail

C="${HERMES:-hermes}"
ACC="${ACC:-FINACC-0001}"
OUT="/root/hermes-phantom-check-$(date +%Y%m%d-%H%M%S).txt"
FS=/opt/data/skills/vvriters-finance/scripts
PY=/opt/data/.hermes/google-workspace-venv/bin/python

redact() {
  sed -E \
    -e 's/(Bearer|Basic)[[:space:]]+[^[:space:]",]+/\1 ***/Ig' \
    -e 's/((api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer|cookie)[^:=[:space:]]*["]?[[:space:]]*[:=][[:space:]]*["]?)[^[:space:]",]+/\1***/Ig' \
    -e 's/[0-9]{8,10}:[A-Za-z0-9_-]{30,}/***TG_TOKEN***/g' \
    -e 's/(sk|pk|rk)-[A-Za-z0-9_-]{16,}/***KEY***/g' \
    -e 's/[A-Za-z0-9_+]{40,}={0,2}/***LONG***/g'
}

U="$(docker exec "$C" stat -c %u:%g "$FS/finance_health.py" 2>/dev/null || echo 10000:10000)"

{
docker exec -i -u "$U" -w "$FS" -e ACC="$ACC" -e PYTHONUNBUFFERED=1 "$C" timeout 600 "$PY" -u - <<'PY'
import contextlib, io, itertools, json, os, runpy, sys, time
from decimal import Decimal, InvalidOperation
from urllib.parse import quote
sys.path.insert(0, ".")
ACC = os.environ.get("ACC", "FINACC-0001")
_T0 = time.time()
def step(msg):
    print(f"[{int(time.time() - _T0):>3}s] {msg}", flush=True)

def dec(v):
    try:
        return Decimal(str(v).replace(" ", "").replace(" ", "").replace(",", "."))
    except (InvalidOperation, ValueError):
        return None

# 1. Перехватываем авторизованные запросы Google Sheets, которые делает штатный health.
from googleapiclient import http as gh
seen = []
_orig_execute = gh.HttpRequest.execute
def _spy_execute(self, *a, **k):
    seen.append(self)
    return _orig_execute(self, *a, **k)
gh.HttpRequest.execute = _spy_execute

step("Запускаю штатный read-only health (чтение таблиц Finance, может ждать лимит Google)…")
sys.argv = ["finance_mvp_cli.py", "health"]
with contextlib.redirect_stdout(io.StringIO()):
    try:
        runpy.run_path("finance_mvp_cli.py", run_name="__main__")
    except SystemExit:
        pass
gh.HttpRequest.execute = _orig_execute
step(f"health прочитан, запросов к Google: {len(seen)}")

base = next((r for r in seen if "sheets.googleapis.com" in r.uri and "/spreadsheets/" in r.uri), None)
if base is None:
    print("!! Не перехватил запрос к Google Sheets:", [r.uri[:80] for r in seen][:5]); raise SystemExit(0)
sid = base.uri.split("/spreadsheets/")[1].split("/")[0].split(":")[0].split("?")[0]

def read_sheet(name):
    uri = (f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/"
           f"{quote(chr(39) + name + chr(39))}"
           f"%21A1%3AZZ?alt=json")
    req = gh.HttpRequest(base.http, base.postproc, uri, method="GET", headers={})
    for attempt in range(6):
        try:
            values = req.execute(num_retries=3).get("values", [])
            break
        except gh.HttpError as e:
            if getattr(e.resp, "status", 0) == 429 and attempt < 5:
                step("Лимит Google Sheets, жду 65 с…"); time.sleep(65); continue
            raise
    if not values:
        return []
    head = [str(h).strip() for h in values[0]]
    return [dict(zip(head, row + [""] * (len(head) - len(row)))) for row in values[1:]]


import re
IDS_RAW = {
    "RAW-C1DD421AF2A96BC3": "KHAMOVNIKI 5880 12:10 (фантом)",
    "RAW-571537FA04319955": "KHAMOVNIKI 5880 12:07 (пропала из ленты)",
    "RAW-8910355B9A98D724": "KHAMOVNIKI 5185",
    "RAW-B58DE8396B7209F2": "KHAMOVNIKI 195",
    "RAW-EB4D61ED9A0A62DC": "SPEKTRA 39280 (исключена из сверки)",
}

def show(row, keys=None):
    keys = keys or [k for k, v in row.items() if str(v).strip()]
    return "\n".join(f"    {k}: {str(row.get(k, ''))[:300]}" for k in keys)

step("Читаю 04_RAW_OPERATION_LINKS…")
links = [r for r in read_sheet("04_RAW_OPERATION_LINKS") if r.get("RAW_EVENT_ID") in IDS_RAW]
ops_ids = {}
for r in links:
    ops_ids.setdefault(r.get("FIN_OPERATION_ID"), []).append(IDS_RAW[r["RAW_EVENT_ID"]])
    print(f"  {r.get('RAW_EVENT_ID')} → {r.get('FIN_OPERATION_ID')}  [{r.get('LINK_ROLE')}, {r.get('MATCH_METHOD')}]  {IDS_RAW[r['RAW_EVENT_ID']]}")

step("Читаю 05_ОПЕРАЦИИ…")
for r in read_sheet("05_ОПЕРАЦИИ"):
    if r.get("FIN_OPERATION_ID") in ops_ids:
        print(f"\n  --- {r.get('FIN_OPERATION_ID')}  ({', '.join(ops_ids[r['FIN_OPERATION_ID']])})")
        print(show(r))

step("Читаю 16_НАСТРОЙКИ…")
for r in read_sheet("16_НАСТРОЙКИ"):
    k = str(r.get("KEY", ""))
    if re.search(r"SECRET|TOKEN|KEY$|PASSWORD|CLIENT_ID", k, re.I) and not re.search(r"CARD_MATCH|PENDING", k):
        continue
    print(f"  {k} = {r.get('VALUE')}   ({r.get('COMMENT', '')[:80]})")

step("Читаю 15_AUDIT_LOG…")
needles = set(IDS_RAW) | {i for i in ops_ids if i}
hits = [r for r in read_sheet("15_AUDIT_LOG") if any(n in json.dumps(r, ensure_ascii=False) for n in needles)]
print(f"  записей аудита по этим операциям: {len(hits)}")
for r in hits[-12:]:
    print(f"\n  --- {r.get('EVENT_AT')} {r.get('ACTOR')} {r.get('ACTION')} {r.get('ENTITY_TYPE')} {r.get('ENTITY_ID')}")
    print(f"    REASON: {str(r.get('REASON', ''))[:300]}")
    print(f"    AFTER:  {str(r.get('AFTER_JSON', ''))[:600]}")
print("\n== Готово")
PY
} 2>&1 | redact | tee "$OUT"
[ "${PIPESTATUS[0]}" = "124" ] && echo "!! Остановлено по таймауту 10 минут (скорее всего, ждали лимит Google Sheets). Запусти ещё раз через пару минут."

echo
echo "== Как сверка PENDING_EXPECTED отбирает авторизации (код)" | tee -a "$OUT"
docker exec -u "$U" "$C" sh -c "grep -nE 'def |STATUS|EXCLUD|exclud|SKIP|skip|CANCEL|cancel|IGNORE|ignore|aged|AGED|max_age|PHANTOM|phantom|OBSERVED_AT' $FS/finance_pending_reconcile.py | cut -c1-200 | head -120" 2>&1 | tee -a "$OUT"
echo
echo "Отчёт сохранён в $OUT — пришли его содержимое."
