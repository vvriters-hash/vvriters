#!/usr/bin/env bash
# 1) Добавляет в vvriters-core/scripts/core_common.py автоповтор ЧТЕНИЙ из Google API
#    при 429 (лимит 60 чтений/мин) и 5xx. Записи (POST/PUT) не трогает.
#    Делает бэкап, проверяет; при ошибке откатывает.
# 2) Только чтение: показывает, какая сверка Finance висит в FAIL и что про неё выяснил сам Гермес.
# Запускать на сервере под root, НЕ внутри контейнера. Контейнер не перезапускается.
set -uo pipefail

C="${HERMES:-hermes}"
OUT="/root/hermes-fix-quota-$(date +%Y%m%d-%H%M%S).txt"
CS=/opt/data/skills/vvriters-core/scripts
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

U="$(docker exec "$C" stat -c %u:%g "$CS/core_common.py" 2>/dev/null || echo 10000:10000)"
E()  { docker exec    -u "$U" -w /opt/data "$C" "$@"; }
EI() { docker exec -i -u "$U" -w /opt/data "$C" "$@"; }

fix() {
  echo "== ШАГ 1. Автоповтор чтений Google API при 429 в core_common.py"
  EI python3 - <<'PY'
import time
from pathlib import Path

p = Path("/opt/data/skills/vvriters-core/scripts/core_common.py")
s = p.read_text(encoding="utf-8")
marker = "# vvriters: retry Google API reads on 429/5xx"
if marker in s:
    print("Уже исправлено ранее — пропускаю.")
    raise SystemExit(0)

block = '''

''' + marker + '''
# Sheets allows 60 reads/min per user; Daily Pulse + finance timers exceed it.
# googleapiclient retries 429/5xx with exponential backoff when num_retries > 0.
# Only GET requests are retried so writes are never duplicated.
try:
    from googleapiclient import http as _vv_gapi_http

    if not getattr(_vv_gapi_http.HttpRequest.execute, "_vv_retry", False):
        _vv_orig_execute = _vv_gapi_http.HttpRequest.execute

        def _vv_execute(self, http=None, num_retries=0):
            if str(getattr(self, "method", "")).upper() == "GET":
                num_retries = max(num_retries, 6)
            return _vv_orig_execute(self, http=http, num_retries=num_retries)

        _vv_execute._vv_retry = True
        _vv_gapi_http.HttpRequest.execute = _vv_execute
except ImportError:
    pass
'''
new = s.rstrip("\n") + "\n" + block
compile(new, str(p), "exec")
backup = p.with_name(p.name + ".bak-429-retry-" + time.strftime("%Y%m%d-%H%M%S"))
backup.write_text(s, encoding="utf-8")
p.write_text(new, encoding="utf-8")
print(f"Исправлено. Бэкап: {backup}")
PY
  echo "--- Проверка"
  if E sh -c "cd $CS && $PY -c 'import core_common; from googleapiclient import http as h; assert getattr(h.HttpRequest.execute, \"_vv_retry\", False); print(\"OK: core_common импортируется, автоповтор включён\")'" 2>&1 \
     && E sh -c "cd $CS && timeout 150 $PY core_read.py daily >/dev/null 2>&1 && echo 'OK: core_read.py daily отрабатывает'"; then
    :
  else
    echo "!! Проверка не прошла — откатываю из последнего бэкапа."
    E sh -c "b=\$(ls -t $CS/core_common.py.bak-429-retry-* 2>/dev/null | head -1); [ -n \"\$b\" ] && cp \"\$b\" $CS/core_common.py && echo \"Откат из \$b\""
  fi
  echo
}

diag() {
  echo "== ШАГ 2. Как запускается проверка Finance"
  systemctl cat vvriters-finance-health.service 2>/dev/null | grep -vE '^\s*#' | grep -E 'ExecStart|User|Environment' | redact
  echo
  echo "--- Команды finance_mvp_cli.py"
  E sh -c "cd $FS && $PY finance_mvp_cli.py --help 2>&1 | head -40"
  echo
  echo "--- Что в SKILL.md vvriters-finance сказано про сверки и их закрытие"
  E sh -c "grep -nIiE 'recon|resolve|RESOLVED_AT|FAIL' /opt/data/skills/vvriters-finance/SKILL.md | cut -c1-240 | head -40"
  echo

  echo "== ШАГ 3. Незакрытые сверки со статусом FAIL / WARN (только чтение)"
  EI sh -c "cd $FS && $PY -" <<'PY'
import inspect, json, sys
sys.path.insert(0, ".")
try:
    import finance_mvp_read as r
except Exception as e:
    print("!! finance_mvp_read не импортируется:", repr(e)); raise SystemExit(0)
import finance_health as h

# Ищем в finance_mvp_read функцию, которая собирает данные для health.
src = inspect.getsource(r)
i = src.find("UNRESOLVED_RECONCILIATION_FAIL")
print("--- finance_mvp_read.py вокруг расчёта health:")
print(src[max(0, i - 3500): i + 600])
PY
  echo

  echo "== ШАГ 4. Что выяснил сам Гермес в сессии «Диагностика UNRESOLVED_RECONCILIATION_FAIL»"
  EI python3 - <<'PY'
import sqlite3
con = sqlite3.connect("file:/opt/data/state.db?mode=ro", uri=True)
scols = [r[1] for r in con.execute("pragma table_info(sessions)")]
mcols = [r[1] for r in con.execute("pragma table_info(messages)")]
print("sessions:", scols)
print("messages:", mcols)
sid_col = "id" if "id" in scols else scols[0]
sid = con.execute(f'select "{sid_col}" from sessions where title like ? order by rowid desc limit 1',
                  ("%UNRESOLVED_RECONCILIATION_FAIL%",)).fetchone()
if not sid:
    print("Сессия не найдена"); raise SystemExit(0)
sid = sid[0]
print("session:", sid)
fk = "session_id" if "session_id" in mcols else None
if not fk:
    print("Не нашёл связь messages→sessions"); raise SystemExit(0)
rows = con.execute(
    f'select rowid, role, content from messages where "{fk}"=? order by rowid', (sid,)).fetchall()
print("сообщений:", len(rows))
for rid, role, content in rows[-12:]:
    c = str(content or "")
    if role == "tool":
        c = c[:1500]
    else:
        c = c[:3000]
    print(f"\n----- #{rid} [{role}]\n{c}")
PY
  echo
  echo "== Готово"
}

{ fix; diag; } 2>&1 | redact | tee "$OUT"
echo
echo "Отчёт сохранён в $OUT — пришли его содержимое."
