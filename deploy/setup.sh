#!/usr/bin/env bash
# Подготовка сервера для тестового стенда VVriters Studio.
# Делает: swap 4 ГБ, Docker + compose (если их нет), папку /opt/vvriters.
# Не перезапускает Docker, не трогает файрвол и работающие контейнеры (Hermes и др.).
# Размер логов ограничивается в docker-compose проекта, а не глобально. Повторный запуск безопасен.
# Запуск на сервере (не в контейнере): sudo bash deploy/setup.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Запусти через sudo: sudo bash deploy/setup.sh"; exit 1; }
if [ -f /.dockerenv ] || [ -f /run/.containerenv ] || [ "$(stat -f -c %T / 2>/dev/null)" = "overlayfs" ]; then echo "Это контейнер. Запусти скрипт на самом сервере."; exit 1; fi

echo "== 1. Swap =="
if [ "$(awk '/SwapTotal/{print $2}' /proc/meminfo)" -lt 2000000 ]; then
  if [ ! -f /swapfile ]; then
    fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Использовать swap только при реальной нехватке памяти
  sysctl -w vm.swappiness=10 >/dev/null
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-vvriters-swap.conf
  echo "Swap 4 ГБ включён"
else
  echo "Swap уже есть — пропускаю"
fi

echo "== 2. Docker =="
if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  echo "Docker установлен"
else
  echo "Docker уже установлен — пропускаю"
  docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-plugin
fi

echo "== 3. Папка проекта =="
mkdir -p /opt/vvriters
chmod 750 /opt/vvriters
echo "/opt/vvriters создана"

echo
echo "Готово. Проверь: free -h ; docker compose version"
