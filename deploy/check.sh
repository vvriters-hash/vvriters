#!/usr/bin/env bash
# Диагностика сервера перед установкой VVriters Studio (тестовый стенд).
# Ничего не меняет — только читает. Запуск: bash deploy/check.sh
set -u

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$*"; }

echo "== Где мы запущены =="
if [ -f /.dockerenv ] || [ -f /run/.containerenv ] || grep -qa 'docker\|containerd\|lxc' /proc/1/cgroup 2>/dev/null \
   || [ "$(stat -f -c %T / 2>/dev/null)" = "overlayfs" ]; then
  bad "Скрипт запущен ВНУТРИ контейнера. Нужно зайти на сам сервер (хост) по SSH и запустить скрипт там."
else
  ok "Похоже на сам сервер (не контейнер)"
fi

echo "== Права =="
if [ "$(id -u)" -eq 0 ]; then ok "root"
elif sudo -n true 2>/dev/null; then ok "sudo без пароля"
elif command -v sudo >/dev/null; then warn "sudo есть, но спросит пароль — это нормально"
else bad "Нет root и sudo — установка невозможна"; fi

echo "== Система =="
. /etc/os-release 2>/dev/null && ok "$PRETTY_NAME ($(uname -m))"

echo "== Память =="
mem_total=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
mem_avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
swap_total=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
echo "  всего ${mem_total} МБ, свободно ${mem_avail} МБ, swap ${swap_total} МБ"
[ "$mem_avail" -ge 1800 ] && ok "Свободной памяти хватит для прототипа" || warn "Свободной памяти мало (<1,8 ГБ)"
[ "$swap_total" -ge 2000 ] && ok "Swap есть" || warn "Swap нет или мало — setup.sh создаст 4 ГБ"

echo "== Диск =="
df -h / | awk 'NR==2{print "  свободно " $4 " из " $2}'

echo "== Docker =="
if command -v docker >/dev/null; then
  ok "$(docker --version)"
  docker compose version >/dev/null 2>&1 && ok "$(docker compose version)" || warn "Нет docker compose plugin"
  echo "  Запущенные контейнеры:"
  docker ps --format '    {{.Names}}  ({{.Image}})  {{.Ports}}' 2>/dev/null || warn "Нет прав на docker (нужен sudo или группа docker)"
else
  warn "Docker не установлен — setup.sh установит"
fi

echo "== Порты 80/443 =="
for p in 80 443; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    warn "Порт $p уже занят: $(ss -ltnp 2>/dev/null | grep -E "[:.]$p " | awk '{print $NF}' | head -1)"
  else ok "Порт $p свободен"; fi
done

echo "== SSH =="
ssh_port=$(ss -ltnp 2>/dev/null | grep -m1 sshd | awk '{print $4}' | sed 's/.*://')
echo "  sshd слушает порт: ${ssh_port:-не найден}"

echo "== Внешний IP =="
ip=$(curl -fsS -4 https://ifconfig.me 2>/dev/null || true)
echo "  ${ip:-не удалось определить}"
[ -n "$ip" ] && echo "  Временный адрес для теста: https://$(echo "$ip" | tr . -).sslip.io"

echo "== Доступ к внешним API =="
for url in https://api.anthropic.com https://api.openai.com https://api.scrapecreators.com https://www.googleapis.com; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$url" 2>/dev/null); code=${code:-000}
  [ "$code" != "000" ] && ok "$url (HTTP $code)" || bad "$url недоступен"
done

echo
echo "Скопируй весь вывод и пришли в чат."
