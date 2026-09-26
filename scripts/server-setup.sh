#!/usr/bin/env bash
# One-time host setup for deploying the site (Debian 12/13).
# Run on the VM itself (not inside a Docker container) as root:
#   sudo bash server-setup.sh [domain] [port]
# Examples:
#   sudo bash server-setup.sh                   # by IP on port 80
#   sudo bash server-setup.sh example.com       # by domain on port 80
#   sudo bash server-setup.sh _ 8080            # by IP on port 8080
set -euo pipefail

DOMAIN="${1:-_}"
PORT="${2:-80}"
DEPLOY_USER="deploy"
DEPLOY_PATH="/var/www/vvriters"
SITE_CONF="/etc/nginx/sites-available/vvriters"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

if [ -f /.dockerenv ] || grep -qa 'docker\|containerd' /proc/1/cgroup 2>/dev/null; then
  echo "This looks like a Docker container. Run the script on the host VM instead." >&2
  exit 1
fi

if ss -ltnp "sport = :$PORT" | grep -q LISTEN && ! ss -ltnp "sport = :$PORT" | grep -q nginx; then
  echo "Port $PORT is already used by another process:" >&2
  ss -ltnp "sport = :$PORT" >&2
  echo "Pick another port: sudo bash $0 $DOMAIN 8080" >&2
  exit 1
fi

apt-get update
apt-get install -y nginx rsync

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_PATH"
if [ ! -e "$DEPLOY_PATH/index.html" ]; then
  echo '<h1>VVriters: waiting for the first deploy</h1>' > "$DEPLOY_PATH/index.html"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_PATH/index.html"
fi

cat > "$SITE_CONF" <<CONF
server {
    listen $PORT;
    listen [::]:$PORT;
    server_name $DOMAIN;
    root $DEPLOY_PATH;
    index index.html;
    location / {
        try_files \$uri \$uri/ =404;
    }
}
CONF
ln -sf "$SITE_CONF" /etc/nginx/sites-enabled/vvriters
if [ "$PORT" = "80" ] && [ "$DOMAIN" = "_" ]; then
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo
echo "Done. Next steps:"
echo "1. Append the public deploy key to /home/$DEPLOY_USER/.ssh/authorized_keys"
echo "2. GitHub secrets: SSH_USER=$DEPLOY_USER  DEPLOY_PATH=$DEPLOY_PATH"
echo "3. SSH_KNOWN_HOSTS secret: run on your computer: ssh-keyscan <YOUR_SERVER_IP>"
echo "4. Open the site: http://<YOUR_SERVER_IP>:$PORT/"
