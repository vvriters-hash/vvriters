#!/usr/bin/env bash
# Обновить стенд до последней версии из GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose -f deploy/docker-compose.yml --profile cli build pipeline
docker compose -f deploy/docker-compose.yml up -d reports
echo "Обновлено: $(git log --oneline -1)"
