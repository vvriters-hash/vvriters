# Деплой на сервер

При каждом пуше в `main` GitHub Actions копирует файлы сайта на сервер по SSH
(`.github/workflows/deploy.yml`). Запустить вручную: вкладка **Actions** →
**Deploy to server** → **Run workflow**.

## Настройка (один раз)

### 1. На сервере

Выполняйте на самой виртуальной машине (хосте), **не внутри Docker-контейнера**
(например, контейнера Hermes): контейнер теряет изменения при пересоздании,
и в нём обычно нет SSH и веб-сервера.

```bash
curl -fsSL https://raw.githubusercontent.com/vvriters-hash/vvriters/main/scripts/server-setup.sh -o server-setup.sh
sudo bash server-setup.sh              # сайт по IP на порту 80
# sudo bash server-setup.sh example.com  # или по домену
# sudo bash server-setup.sh _ 8080       # если порт 80 уже занят
```

Скрипт ставит nginx и rsync, создаёт пользователя `deploy` и папку
`/var/www/vvriters` и настраивает nginx. Если репозиторий приватный,
скопируйте скрипт на сервер вручную (например, через `scp`).

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

## Важно

`rsync --delete` удаляет в `DEPLOY_PATH` файлы, которых нет в репозитории.
Не указывайте в `DEPLOY_PATH` папку, где лежит что-то ещё.
