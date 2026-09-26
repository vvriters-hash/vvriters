#!/usr/bin/env bash
# Только чтение. Находит карточные авторизации (pending) по счёту, из-за которых
# сверка PENDING_EXPECTED не сходится, и подбирает операции, дающие разницу.
# Запускать на сервере под root, НЕ внутри контейнера.
set -uo pipefail

C="${HERMES:-hermes}"
ACC="${ACC:-FINACC-0001}"
OUT="/root/hermes-pending-show-$(date +%Y%m%d-%H%M%S).txt"
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

# 2. Актуальная сверка PENDING_EXPECTED
import finance_health as fh
step("Читаю 13_СВЕРКИ…")
recs = read_sheet("13_СВЕРКИ")
latest = [x for x in fh.latest_reconciliation_snapshots(recs)
          if x.get("RECON_TYPE") == "PENDING_EXPECTED" and x.get("FIN_ACCOUNT_ID") == ACC]
diffs, want_count = [], None
for x in latest:
    d = fh.reconciliation_details(x)
    want_count = d.get("pending_count")
    print(f"Актуальная сверка: {x.get('STATUS')} expected={x.get('EXPECTED_VALUE')} actual={x.get('ACTUAL_VALUE')} "
          f"diff={x.get('DIFF_VALUE')} pending_count={want_count} pending_observed_at={d.get('pending_observed_at')} "
          f"({x.get('CREATED_AT')})")
    if dec(x.get("DIFF_VALUE")):
        diffs.append(dec(x.get("DIFF_VALUE")))
if os.environ.get("DIFF"):
    diffs = [Decimal(os.environ["DIFF"])]

# 3. Карточные авторизации по счёту
step("Читаю 03_BANK_EVENTS_RAW…")
raw = [r for r in read_sheet("03_BANK_EVENTS_RAW") if r.get("FIN_ACCOUNT_ID") == ACC]
from collections import Counter
print("Источники событий по счёту:", dict(Counter((r.get("SOURCE_ENDPOINT"), r.get("BANK_STATUS")) for r in raw)))
card = [r for r in raw if r.get("PAN_MASK") or "card" in str(r.get("SOURCE_ENDPOINT", "")).lower()
        or "author" in str(r.get("SOURCE_ENDPOINT", "")).lower()]
if not card:
    print("!! Не нашёл карточные события по счёту"); raise SystemExit(0)
last_obs = max(str(r.get("OBSERVED_AT", "")) for r in card)
batch = [r for r in card if str(r.get("OBSERVED_AT", "")) == last_obs]
amt = lambda r: dec(r.get("ACCOUNT_AMOUNT") or r.get("AMOUNT")) or Decimal(0)
print(f"\nПоследний срез авторизаций OBSERVED_AT={last_obs}: {len(batch)} операций на {sum(map(amt, batch))} ₽"
      f"  (в сверке pending_count={want_count})")
show = ("RAW_EVENT_ID", "EVENT_DATETIME", "AMOUNT", "CURRENCY", "TERMINAL_OWNER", "TERMINAL_CITY",
        "BANK_STATUS", "PROCESSING_STATUS", "IMPORTED_AT")
for r in sorted(batch, key=lambda r: str(r.get("EVENT_DATETIME", ""))):
    print("  " + " | ".join(str(r.get(c, "")) for c in show))

# Авторизации, появившиеся 25.09 около 12:08–12:18 МСК, когда сверка сломалась
print("\nКарточные события, импортированные 25.09.2026 (день, когда сверка перестала сходиться):")
for r in sorted(card, key=lambda r: str(r.get("IMPORTED_AT", ""))):
    if str(r.get("IMPORTED_AT", "")).startswith("2026-09-25"):
        print("  " + " | ".join(str(r.get(c, "")) for c in show))

for d in diffs:
    amts = [(r, amt(r)) for r in batch]
    hits = [c for n in (1, 2, 3) for c in itertools.combinations(amts, n)
            if abs(sum(x[1] for x in c) - d) <= Decimal("0.01")]
    print(f"\nОперации, которые в сумме дают разницу {d} ₽: {len(hits)} вариант(ов)")
    for c in hits[:10]:
        print("  • " + " + ".join(f"{x[0].get('TERMINAL_OWNER','?')} {x[1]} ₽ ({x[0].get('EVENT_DATETIME','')}, "
                                    f"{x[0].get('RAW_EVENT_ID','')})" for x in c))
print("\n== Готово")
PY
} 2>&1 | redact | tee "$OUT"
[ "${PIPESTATUS[0]}" = "124" ] && echo "!! Остановлено по таймауту 10 минут (скорее всего, ждали лимит Google Sheets). Запусти ещё раз через пару минут."
echo
echo "Отчёт сохранён в $OUT — пришли его содержимое."
