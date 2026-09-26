#!/usr/bin/env bash
# 1) Чинит импорт core_common/core_read в vvriters-finance/scripts/finance_project_summary.py
#    (делает бэкап, проверяет компиляцию и импорт; при ошибке откатывает).
# 2) Только чтение: ищет, откуда берётся статус RED / UNRESOLVED_RECONCILIATION_FAIL,
#    и полный текст утренних ошибок core_read.py из базы сессий Гермеса.
# Запускать на сервере под root, НЕ внутри контейнера. Контейнер не перезапускается.
set -uo pipefail

C="${HERMES:-hermes}"
OUT="/root/hermes-fix-finance-$(date +%Y%m%d-%H%M%S).txt"
FS=/opt/data/skills/vvriters-finance/scripts

redact() {
  sed -E \
    -e 's/(Bearer|Basic)[[:space:]]+[^[:space:]",]+/\1 ***/Ig' \
    -e 's/((api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer|cookie)[^:=[:space:]]*["]?[[:space:]]*[:=][[:space:]]*["]?)[^[:space:]",]+/\1***/Ig' \
    -e 's/[0-9]{8,10}:[A-Za-z0-9_-]{30,}/***TG_TOKEN***/g' \
    -e 's/(sk|pk|rk)-[A-Za-z0-9_-]{16,}/***KEY***/g' \
    -e 's/[A-Za-z0-9_+]{40,}={0,2}/***LONG***/g'
}

U="$(docker exec "$C" stat -c %u:%g "$FS/finance_project_summary.py" 2>/dev/null || echo 10000:10000)"
E()  { docker exec    -u "$U" -w /opt/data "$C" "$@"; }
EI() { docker exec -i -u "$U" -w /opt/data "$C" "$@"; }

fix() {
  echo "== ШАГ 1. Исправление импорта в finance_project_summary.py"
  EI python3 - <<'PY'
import time
from pathlib import Path

p = Path("/opt/data/skills/vvriters-finance/scripts/finance_project_summary.py")
s = p.read_text(encoding="utf-8")
marker = "# vvriters: make vvriters-core/scripts importable"
if marker in s:
    print("Уже исправлено ранее — пропускаю.")
    raise SystemExit(0)

anchor = "from __future__ import annotations\n"
if s.count(anchor) != 1:
    print("!! Не нашёл ожидаемое начало файла — ничего не меняю.")
    raise SystemExit(1)

block = (
    anchor
    + "\n" + marker + "\n"
    + "import sys\n"
    + "from pathlib import Path\n"
    + "\n"
    + '_CORE_SCRIPTS = Path(__file__).resolve().parents[2] / "vvriters-core" / "scripts"\n'
    + "if str(_CORE_SCRIPTS) not in sys.path:\n"
    + "    sys.path.append(str(_CORE_SCRIPTS))\n"
)
new = s.replace(anchor, block, 1)
compile(new, str(p), "exec")

backup = p.with_name(p.name + ".bak-core-path-" + time.strftime("%Y%m%d-%H%M%S"))
backup.write_text(s, encoding="utf-8")
p.write_text(new, encoding="utf-8")
print(f"Исправлено. Бэкап: {backup}")
PY
  echo "--- Проверка импорта"
  if E sh -c "cd $FS && python3 -c 'import finance_project_summary; print(\"OK: finance_project_summary импортируется\")'" 2>&1; then
    :
  else
    echo "!! Импорт всё ещё падает — откатываю из последнего бэкапа."
    E sh -c "b=\$(ls -t $FS/finance_project_summary.py.bak-core-path-* 2>/dev/null | head -1); [ -n \"\$b\" ] && cp \"\$b\" $FS/finance_project_summary.py && echo \"Откат из \$b\""
  fi
  echo
}

diag() {
  echo "== ШАГ 2. Откуда берётся UNRESOLVED / RECONCILIATION в Finance"
  E sh -c "grep -rnI -E 'UNRESOLVED|RECONCILIATION|_FAIL\b|RED\b|GREEN|YELLOW' $FS/finance_health.py $FS/finance_health_sync.py $FS/finance_alerts.py $FS/finance_telegram_alert.py $FS/finance_mvp_read.py $FS/finance_mvp_cli.py $FS/finance_dashboard.py 2>/dev/null | cut -c1-260 | head -80"
  echo
  echo "--- finance_health.py целиком"
  E cat "$FS/finance_health.py"
  echo

  echo "== ШАГ 3. Кто запускает проверку Finance (время в статусе — 06:43 МСК)"
  echo "--- crontab внутри контейнера"
  E sh -c 'crontab -l 2>&1; ls -la /etc/cron.d 2>/dev/null' | head -20
  echo "--- crontab и таймеры на сервере"
  crontab -l 2>&1 | head -20
  systemctl list-timers --all --no-pager 2>/dev/null | head -20
  echo

  echo "== ШАГ 4. Поиск в базе сессий Гермеса: статус RED и утренние ошибки core_read.py"
  EI python3 - <<'PY'
import glob, sqlite3
dbs = sorted(set(glob.glob("/opt/data/*.db") + glob.glob("/opt/data/.hermes/*.db")))
print("Базы:", dbs)
pats = [
    ("UNRESOLVED_RECONCILIATION_FAIL", 1500, 1500),
    ("line 1394, in <module>", 200, 2500),
    ("No module named", 1200, 300),
]
for db in dbs:
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        tabs = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
    except Exception as e:
        print("!!", db, e); continue
    for pat, before, after in pats:
        shown = 0
        for t in tabs:
            if shown >= 2:
                break
            try:
                cols = [r[1] for r in con.execute(f'pragma table_info("{t}")')
                        if (r[2] or "").upper() in ("TEXT", "")]
            except Exception:
                continue
            for c in cols:
                if shown >= 2:
                    break
                try:
                    rows = con.execute(
                        f'select rowid, "{c}" from "{t}" where "{c}" like ? order by rowid desc limit 2',
                        (f"%{pat}%",)).fetchall()
                except Exception:
                    continue
                for rid, v in rows:
                    if shown >= 2:
                        break
                    v = str(v); i = v.find(pat)
                    print(f"\n----- {db} :: {t}.{c} rowid={rid}  [{pat}]")
                    print(v[max(0, i - before): i + after])
                    shown += 1
        if shown == 0:
            print(f"\n(в {db} не найдено: {pat})")
PY
  echo
  echo "== Готово"
}

{ fix; diag; } 2>&1 | redact | tee "$OUT"
echo
echo "Отчёт сохранён в $OUT — пришли его содержимое."
