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
docker exec -i -u "$U" -w "$FS" -e ACC="$ACC" "$C" "$PY" - <<'PY'
import contextlib, importlib, inspect, io, itertools, json, os, runpy, sys
from decimal import Decimal, InvalidOperation
sys.path.insert(0, ".")
ACC = os.environ.get("ACC", "FINACC-0001")

def dec(v):
    try:
        return Decimal(str(v).replace(" ", "").replace(",", "."))
    except (InvalidOperation, ValueError):
        return None

# 1. Список листов Finance и их колонок
try:
    import finance_config as cfg
    schemas = getattr(cfg, "SHEET_SCHEMAS", {}) or {}
except Exception as e:
    print("!! finance_config:", repr(e)); schemas = {}

def cols_of(v):
    if isinstance(v, dict):
        for k in ("columns", "headers", "COLUMNS", "HEADERS"):
            if k in v:
                return list(v[k])
        return list(v.keys())
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v]
    return []

print("== Листы Finance:")
for name, v in schemas.items():
    c = cols_of(v)
    print(f"  {name}: {', '.join(c[:12])}{' …' if len(c) > 12 else ''}")

# 2. Перехватываем функции чтения, которыми пользуется штатный read-only health
calls = []
mods = []
for mname in ("finance_sheet_store", "finance_google", "finance_google_quota", "finance_mvp_read"):
    try:
        mods.append(importlib.import_module(mname))
    except Exception as e:
        print(f"(модуль {mname} не подключился: {e!r})")

def wrap(fn, label):
    def w(*a, **k):
        r = fn(*a, **k)
        calls.append((label, fn, a, k, r))
        return r
    w.__wrapped__ = fn
    return w

for m in mods:
    for n, f in inspect.getmembers(m, inspect.isfunction):
        if f.__module__ == m.__name__:
            setattr(m, n, wrap(f, f"{m.__name__}.{n}"))

sys.argv = ["finance_mvp_cli.py", "health"]
with contextlib.redirect_stdout(io.StringIO()):
    try:
        runpy.run_path("finance_mvp_cli.py", run_name="__main__")
    except SystemExit:
        pass

def is_rows(r):
    return isinstance(r, list) and r and isinstance(r[0], dict)

readers = []
for label, fn, a, k, r in calls:
    if not is_rows(r):
        continue
    for i, x in enumerate(a):
        if isinstance(x, str) and x in schemas:
            readers.append((label, fn, a, k, i, x)); break
    else:
        for kk, x in k.items():
            if isinstance(x, str) and x in schemas:
                readers.append((label, fn, a, k, kk, x)); break

print("\n== Чтения листов в health:", sorted({(r[0], r[5]) for r in readers}))
if not readers:
    print("!! Не нашёл функцию чтения листа. Вызовы:",
          sorted({c[0] for c in calls})[:40])
    raise SystemExit(0)

# 3. Лист с карточными авторизациями: колонки RAW_EVENT_ID + PAN_MASK + OBSERVED_AT
cands = [n for n, v in schemas.items()
         if {"RAW_EVENT_ID", "OBSERVED_AT", "AMOUNT"} <= set(cols_of(v))]
print("Листы-кандидаты с авторизациями:", cands)

label, fn, a, k, pos, _ = readers[0]
def read(sheet):
    a2, k2 = list(a), dict(k)
    if isinstance(pos, int):
        a2[pos] = sheet
    else:
        k2[pos] = sheet
    f = getattr(fn, "__wrapped__", fn)
    return f(*a2, **k2)

for sheet in cands:
    try:
        rows = read(sheet)
    except Exception as e:
        print(f"!! {sheet}: {e!r}"); continue
    acc_rows = [r for r in rows if str(r.get("FIN_ACCOUNT_ID", "")) == ACC]
    print(f"\n==== Лист {sheet}: всего {len(rows)}, по {ACC}: {len(acc_rows)}")
    if not acc_rows:
        continue
    last_obs = max(str(r.get("OBSERVED_AT", "")) for r in acc_rows)
    batch = [r for r in acc_rows if str(r.get("OBSERVED_AT", "")) == last_obs]
    total = sum((dec(r.get("ACCOUNT_AMOUNT") or r.get("AMOUNT")) or 0) for r in batch)
    print(f"Последний срез OBSERVED_AT={last_obs}: {len(batch)} операций на сумму {total}")
    show = ("RAW_EVENT_ID", "EVENT_DATETIME", "AMOUNT", "ACCOUNT_AMOUNT", "CURRENCY",
            "TERMINAL_OWNER", "TERMINAL_CITY", "BANK_STATUS", "PROCESSING_STATUS", "IMPORTED_AT")
    for r in sorted(batch, key=lambda r: str(r.get("EVENT_DATETIME", ""))):
        print("  " + " | ".join(str(r.get(c, "")) for c in show))

    # 4. Какие операции дают разницу из актуальной FAIL-сверки
    diff_env = os.environ.get("DIFF")
    diffs = [Decimal(diff_env)] if diff_env else []
    try:
        recs = read(next(n for n in schemas if "RECON" in n.upper() or "СВЕР" in n.upper()))
        import finance_health as fh
        latest = [x for x in fh.latest_reconciliation_snapshots(recs)
                  if x.get("RECON_TYPE") == "PENDING_EXPECTED" and x.get("FIN_ACCOUNT_ID") == ACC]
        for x in latest:
            print(f"\nАктуальная сверка: {x.get('STATUS')} expected={x.get('EXPECTED_VALUE')} "
                  f"actual={x.get('ACTUAL_VALUE')} diff={x.get('DIFF_VALUE')} ({x.get('CREATED_AT')})")
            d = dec(x.get("DIFF_VALUE"))
            if d:
                diffs.append(d)
    except StopIteration:
        pass
    except Exception as e:
        print("(сверку перечитать не удалось:", repr(e), ")")

    for d in diffs:
        amts = [(r, dec(r.get("ACCOUNT_AMOUNT") or r.get("AMOUNT")) or 0) for r in batch]
        hits = []
        for n in (1, 2, 3):
            for combo in itertools.combinations(amts, n):
                if abs(sum(x[1] for x in combo) - d) <= Decimal("0.01"):
                    hits.append(combo)
        print(f"\nОперации, которые в сумме дают разницу {d}: {len(hits)} вариант(ов)")
        for combo in hits[:10]:
            print("  • " + " + ".join(
                f"{x[0].get('TERMINAL_OWNER','?')} {x[1]} ({x[0].get('EVENT_DATETIME','')}, {x[0].get('RAW_EVENT_ID','')})"
                for x in combo))
print("\n== Готово")
PY
} 2>&1 | redact | tee "$OUT"
echo
echo "Отчёт сохранён в $OUT — пришли его содержимое."
