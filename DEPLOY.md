# Деплой на сервер

При каждом пуше в `main` GitHub Actions копирует файлы сайта на сервер по SSH
(`.github/workflows/deploy.yml`). Запустить вручную: вкладка **Actions** →
**Deploy to server** → **Run workflow**.

## Настройка (один раз)

### 1. На сервере

```bash
# отдельный пользователь для деплоя (рекомендуется)
sudo adduser --disabled-password deploy
sudo mkdir -p /var/www/vvriters
sudo chown deploy:deploy /var/www/vvriters
sudo apt install -y rsync   # rsync нужен и на сервере
```

### 2. Ключ для деплоя (на своём компьютере)

```bash
ssh-keygen -t ed25519 -f vvriters_deploy -N "" -C "github-actions-deploy"
```

Содержимое `vvriters_deploy.pub` добавьте на сервере в
`/home/deploy/.ssh/authorized_keys`.

Отпечаток хоста сервера для проверки подлинности:

```bash
ssh-keyscan -p 22 ВАШ_СЕРВЕР
```

### 3. Секреты в GitHub

Репозиторий → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**:

| Секрет            | Значение                                              |
|-------------------|-------------------------------------------------------|
| `SSH_HOST`        | IP или домен сервера                                  |
| `SSH_USER`        | `deploy`                                              |
| `SSH_PRIVATE_KEY` | содержимое файла `vvriters_deploy` (приватный ключ)   |
| `DEPLOY_PATH`     | `/var/www/vvriters`                                   |
| `SSH_PORT`        | порт SSH, если не 22 (необязательно)                  |
| `SSH_KNOWN_HOSTS` | вывод `ssh-keyscan` из шага 2 (рекомендуется)         |

После этого удалите локальный приватный ключ или храните его в надёжном месте.

### 4. Веб-сервер

Папку `DEPLOY_PATH` должен раздавать веб-сервер, например nginx:

```nginx
server {
    listen 80;
    server_name example.com;
    root /var/www/vvriters;
    index index.html;
}
```

## Важно

`rsync --delete` удаляет в `DEPLOY_PATH` файлы, которых нет в репозитории.
Не указывайте в `DEPLOY_PATH` папку, где лежит что-то ещё.
