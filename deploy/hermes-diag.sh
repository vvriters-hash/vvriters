#!/usr/bin/env bash
# Диагностика Гермеса по ошибке сверки финансов (UNRESOLVED_RECONCILIATION_FAIL).
# Только чтение: ничего не меняет, не перезапускает контейнеры.
# Запускать на самом сервере под root, НЕ внутри контейнера Гермеса.
# Секреты (ключи, токены, пароли) в выводе маскируются; файлы .env не читаются.
set -uo pipefail

OUT="/root/hermes-diag-$(date +%Y%m%d-%H%M%S).txt"
SINCE="${SINCE:-72h}"
KEYWORDS='reconcil|RECONCILIATION|сверк|finance|финанс|RED|UNRESOLVED'

redact() {
  sed -E \
    -e 's/(Bearer|Basic)[[:space:]]+[^[:space:]",]+/\1 ***/Ig' \
    -e 's/((api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer|cookie)[^:=[:space:]]*["]?[[:space:]]*[:=][[:space:]]*["]?)[^[:space:]",]+/\1***/Ig' \
    -e 's/[0-9]{8,10}:[A-Za-z0-9_-]{30,}/***TG_TOKEN***/g' \
    -e 's/(sk|pk|rk)-[A-Za-z0-9_-]{16,}/***KEY***/g' \
    -e 's/[A-Za-z0-9_+]{40,}={0,2}/***LONG***/g'
}

main() {
  echo "== Время на сервере: $(date -Iseconds)"
  echo

  if [ -f /.dockerenv ]; then
    echo "!! Похоже, скрипт запущен внутри контейнера. Выйди на сам сервер и запусти снова."
    exit 1
  fi

  echo "== Контейнеры"
  docker ps -a --format '{{.Names}}  |  {{.Image}}  |  {{.Status}}'
  echo

  C="${HERMES:-$(docker ps -a --format '{{.Names}} {{.Image}}' | grep -i hermes | head -1 | awk '{print $1}')}"
  if [ -z "$C" ]; then
    echo "!! Контейнер Гермеса не найден по имени. Запусти так: HERMES=<имя_контейнера> bash hermes-diag.sh"
    exit 1
  fi
  echo "== Контейнер Гермеса: $C"
  docker inspect -f 'Статус={{.State.Status}}  Запущен={{.State.StartedAt}}  Рестартов={{.RestartCount}}  ExitCode={{.State.ExitCode}}  Health={{if .State.Health}}{{.State.Health.Status}}{{else}}нет{{end}}' "$C"
  docker stats --no-stream --format 'CPU={{.CPUPerc}}  RAM={{.MemUsage}}' "$C" 2>/dev/null
  echo
  echo "== Диск и память сервера"
  df -h / | tail -1
  free -h | head -2
  echo

  echo "== Логи за $SINCE: строки про сверку/финансы"
  docker logs --since "$SINCE" "$C" 2>&1 | grep -iE "$KEYWORDS" | tail -150 | redact
  echo
  echo "== Логи за $SINCE: ошибки"
  docker logs --since "$SINCE" "$C" 2>&1 | grep -iE 'error|exception|traceback|fail|denied|401|403|404|429|timeout' | tail -100 | redact
  echo
  echo "== Последние 60 строк лога"
  docker logs --tail 60 "$C" 2>&1 | redact
  echo

  echo "== Файлы внутри контейнера, где упоминается сверка/финансы (без .env)"
  docker exec "$C" sh -c '
    for d in /root /home /app /opt /data /srv; do [ -d "$d" ] && echo "$d"; done |
    while read -r d; do
      find "$d" -maxdepth 6 -type f -size -2M \
        ! -name ".env*" ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/site-packages/*" \
        ! -path "*/__pycache__/*" ! -path "*/.cache/*" 2>/dev/null
    done | xargs -r grep -IliE "reconcil|RECONCILIATION|сверк|VVriters Finance" 2>/dev/null | head -40
  ' 2>&1
  echo

  echo "== Фрагменты этих файлов (по 3 строки вокруг совпадения)"
  docker exec "$C" sh -c '
    for d in /root /home /app /opt /data /srv; do [ -d "$d" ] && echo "$d"; done |
    while read -r d; do
      find "$d" -maxdepth 6 -type f -size -2M \
        ! -name ".env*" ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/site-packages/*" \
        ! -path "*/__pycache__/*" ! -path "*/.cache/*" 2>/dev/null
    done | xargs -r grep -IliE "reconcil|RECONCILIATION|сверк|VVriters Finance" 2>/dev/null | head -15 |
    while read -r f; do
      echo "----- $f"
      grep -nIiE -C3 "reconcil|RECONCILIATION|сверк|UNRESOLVED|VVriters Finance" "$f" | head -80
    done
  ' 2>&1 | redact
  echo

  echo "== Расписания (cron) Гермеса"
  docker exec "$C" sh -c '
    find / -maxdepth 6 \( -path /proc -o -path /sys -o -path "*/node_modules" -o -path "*/site-packages" \) -prune -o \
      -type f \( -path "*cron*" -name "*.json" -o -path "*cron*" -name "*.y*ml" \) -print 2>/dev/null | head -10 |
    while read -r f; do echo "----- $f"; head -c 6000 "$f"; echo; done
  ' 2>&1 | redact
  echo
  echo "== Готово"
}

main 2>&1 | tee "$OUT"
echo
echo "Отчёт сохранён в $OUT — пришли его содержимое (секреты уже замаскированы, но пробеги глазами перед отправкой)."
