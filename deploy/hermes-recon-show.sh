#!/usr/bin/env bash
# Только чтение. Показывает, какая сверка VVriters Finance сейчас висит в FAIL/WARN
# (то, из-за чего health = RED), историю этой сверки и доступные команды закрытия.
# Запускать на сервере под root, НЕ внутри контейнера.
set -uo pipefail

C="${HERMES:-hermes}"
OUT="/root/hermes-recon-show-$(date +%Y%m%d-%H%M%S).txt"
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
E()  { docker exec    -u "$U" -w /opt/data "$C" "$@"; }
EI() { docker exec -i -u "$U" -w /opt/data "$C" "$@"; }

main() {
  echo "== ШАГ 1. Текущие незакрытые FAIL/WARN сверки (данные берутся штатным read-only 'health')"
  EI sh -c "cd $FS && $PY -" <<'PY'
import contextlib, io, json, runpy, sys
from collections import Counter
sys.path.insert(0, ".")

import finance_health as fh
captured = {}

orig_eval = fh.evaluate_health
def spy_eval(**kw):
    captured.setdefault("recs", kw.get("reconciliations"))
    return orig_eval(**kw)
fh.evaluate_health = spy_eval

try:
    import finance_mvp_read as mr
    orig_mr = mr.finance_health
    def spy_mr(reconciliations, *a, **kw):
        captured.setdefault("recs", reconciliations)
        return orig_mr(reconciliations, *a, **kw)
    mr.finance_health = spy_mr
except Exception as e:
    print("(finance_mvp_read не подключился:", repr(e), ")")

sys.argv = ["finance_mvp_cli.py", "health"]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    try:
        runpy.run_path("finance_mvp_cli.py", run_name="__main__")
    except SystemExit:
        pass
out = buf.getvalue()
try:
    h = json.loads(out)
    print("health:", h.get("assessment"), h.get("reason_codes") or h.get("reason"))
except Exception:
    print(out[:1500])

recs = captured.get("recs")
if not recs:
    print("!! Не удалось перехватить строки сверок."); raise SystemExit(0)

latest = fh.latest_reconciliation_snapshots(recs)
print(f"\nВсего строк сверок: {len(recs)}; актуальных (последних по каждой сверке): {len(latest)}")
print("Актуальные по типу/статусу:",
      dict(Counter((str(r.get('RECON_TYPE')), str(r.get('STATUS'))) for r in latest)))

bad = [r for r in latest if str(r.get("STATUS")) in ("FAIL", "WARN") and not str(r.get("RESOLVED_AT") or "").strip()]
print(f"\n--- Незакрытые FAIL/WARN: {len(bad)}")
for r in bad:
    print(json.dumps(r, ensure_ascii=False, indent=2))

# История той же сверки (тот же scope): когда она последний раз была OK.
for r in bad:
    scope = fh.reconciliation_scope(r)
    hist = sorted((x for x in recs if fh.reconciliation_scope(x) == scope), key=fh.reconciliation_order_key)
    print(f"\n--- История сверки {scope}: {len(hist)} записей")
    print("Статусы:", dict(Counter(str(x.get('STATUS')) for x in hist)))
    last_ok = [x for x in hist if str(x.get("STATUS")) not in ("FAIL", "WARN")]
    print("Последний не-FAIL:", last_ok[-1].get("CREATED_AT") if last_ok else "не было")
    first_fail_streak = None
    for x in reversed(hist):
        if str(x.get("STATUS")) == "FAIL":
            first_fail_streak = x.get("CREATED_AT")
        else:
            break
    print("FAIL непрерывно с:", first_fail_streak)
    print("Последние 5 записей (время | статус | expected | actual | diff | причина):")
    for x in hist[-5:]:
        d = fh.reconciliation_details(x)
        print(" ", x.get("CREATED_AT"), "|", x.get("STATUS"), "|", x.get("EXPECTED_VALUE"), "|",
              x.get("ACTUAL_VALUE"), "|", x.get("DIFF_VALUE"), "|",
              d.get("reason") or d.get("mode") or d.get("check_code") or x.get("REASON") or "")
PY
  echo

  echo "== ШАГ 2. Есть ли штатная команда закрытия сверки (RESOLVED_AT)"
  E sh -c "grep -nIE 'RESOLVED_AT|add_parser\(|def (resolve|close)_' $FS/finance_write.py $FS/finance_write_phase7.py $FS/finance_reconcile_store.py $FS/finance_pending_lifecycle.py $FS/finance_pending_reconcile.py $FS/finance_pending_reconcile_sync.py 2>/dev/null | cut -c1-220 | head -40"
  echo "--- SKILL.md: pending / SPEKTRA / дубли"
  E sh -c "grep -nIiE 'pending|duplicate|дубл|PENDING_EXPECTED|calibration' /opt/data/skills/vvriters-finance/SKILL.md | cut -c1-240 | head -30"
  echo

  echo "== ШАГ 3. Окончание вывода Гермеса от 07.09 (рекомендации)"
  EI python3 - <<'PY'
import sqlite3
con = sqlite3.connect("file:/opt/data/state.db?mode=ro", uri=True)
row = con.execute("select content from messages where id=7068").fetchone() \
   or con.execute("select content from messages where rowid=7068").fetchone()
print(str(row[0])[2800:7500] if row else "не найдено")
PY
  echo
  echo "== Готово"
}

main 2>&1 | redact | tee "$OUT"
echo
echo "Отчёт сохранён в $OUT — пришли его содержимое."
