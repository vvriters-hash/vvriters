#!/usr/bin/env bash
# Прицельная диагностика навыков VVriters (core / finance) внутри Гермеса.
# Только чтение: ничего не меняет, не перезапускает. Запускать на сервере под root.
# Секреты маскируются; .env не читается.
set -uo pipefail

C="${HERMES:-hermes}"
OUT="/root/hermes-finance-diag-$(date +%Y%m%d-%H%M%S).txt"
S=/opt/data/skills

redact() {
  sed -E \
    -e 's/(Bearer|Basic)[[:space:]]+[^[:space:]",]+/\1 ***/Ig' \
    -e 's/((api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer|cookie)[^:=[:space:]]*["]?[[:space:]]*[:=][[:space:]]*["]?)[^[:space:]",]+/\1***/Ig' \
    -e 's/[0-9]{8,10}:[A-Za-z0-9_-]{30,}/***TG_TOKEN***/g' \
    -e 's/(sk|pk|rk)-[A-Za-z0-9_-]{16,}/***KEY***/g' \
    -e 's/[A-Za-z0-9_+]{40,}={0,2}/***LONG***/g'
}

# Запускаем от того же пользователя, что и Гермес, чтобы не плодить root-файлы.
U="$(docker exec "$C" stat -c %u:%g /opt/data/cron/jobs.json 2>/dev/null || echo 0:0)"
E() { docker exec -u "$U" -w /opt/data "$C" "$@"; }
EI() { docker exec -i -u "$U" -w /opt/data "$C" "$@"; }

main() {
  echo "== Пользователь Гермеса: $U"
  echo

  echo "== Все cron-задачи (кратко)"
  EI python3 - <<'PY'
import json
for j in json.load(open("/opt/data/cron/jobs.json"))["jobs"]:
    print(f'- {j.get("name")} | {j.get("schedule_display")} | enabled={j.get("enabled")} | '
          f'last={j.get("last_run_at")} {j.get("last_status")} | err={str(j.get("last_error"))[:300]} | '
          f'skills={j.get("skills")} | script={j.get("script")}')
PY
  echo

  echo "== Навыки VVriters"
  E sh -c "ls -la $S | grep -i vvriters; echo; ls -la $S/vvriters-finance $S/vvriters-finance/scripts $S/vvriters-core/scripts 2>&1"
  echo

  echo "== Где выставляется UNRESOLVED_RECONCILIATION_FAIL / reconciliation"
  E sh -c "grep -rnI --exclude-dir=.curator_backups -E 'UNRESOLVED_RECONCILIATION|RECONCILIATION_FAIL|reconcil' $S/vvriters-* 2>/dev/null | cut -c1-300 | head -60"
  echo

  echo "== Где лежит core_common.py и как finance его импортирует"
  E sh -c "find /opt/data -name core_common.py -not -path '*/.curator_backups/*' -not -path '*/backups/*' 2>/dev/null"
  echo "--- начало finance_project_summary.py"
  E sh -c "head -25 $S/vvriters-finance/scripts/finance_project_summary.py"
  echo "--- импорты core_common / sys.path в finance"
  E sh -c "grep -rnI -E 'core_common|sys\.path|VVRITERS_CORE' $S/vvriters-finance 2>/dev/null | head -30"
  echo

  echo "== Воспроизведение: finance_project_summary.py --help"
  E sh -c "cd $S/vvriters-finance/scripts && timeout 60 python3 finance_project_summary.py --help 2>&1 | tail -25"
  echo

  echo "== Какие команды core_read.py / finance вызывал Гермес сегодня и вчера"
  E sh -c "find /opt/data/sessions -type f -mtime -2 2>/dev/null | xargs -r grep -ohE '(core_read|finance_[a-z_]+)\.py[^\"\\\\]{0,160}' 2>/dev/null | sort | uniq -c | sort -rn | head -30"
  echo

  echo "== Текст ошибок из сессий за 2 дня (без трейсбеков целиком)"
  E sh -c "find /opt/data/sessions -type f -mtime -2 2>/dev/null | xargs -r grep -ohE '[A-Za-z]*(Error|Exception): [^\"\\\\]{0,250}' 2>/dev/null | sort | uniq -c | sort -rn | head -40"
  echo

  echo "== Контекст статуса RED в сессиях за 2 дня"
  E sh -c "find /opt/data/sessions -type f -mtime -2 2>/dev/null | xargs -r grep -ohE '.{0,500}UNRESOLVED_RECONCILIATION_FAIL.{0,500}' 2>/dev/null | head -3"
  echo

  echo "== Воспроизведение: core_read.py --help и daily"
  E sh -c "cd $S/vvriters-core/scripts && timeout 60 python3 core_read.py --help 2>&1 | head -40"
  echo "---"
  E sh -c "cd $S/vvriters-core/scripts && timeout 120 python3 core_read.py daily 2>&1 | tail -40"
  echo
  echo "== Готово"
}

main 2>&1 | redact | tee "$OUT"
echo
echo "Отчёт сохранён в $OUT — пришли его содержимое."
