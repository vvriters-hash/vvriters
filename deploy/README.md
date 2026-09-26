# Тестовый стенд на VPS

Сервер заказчика: Австрия, Debian 13, 2 vCPU, 3,8 ГБ RAM (свободно ~2,3 ГБ), 125 ГБ диска.
На сервере уже работают **Hermes** и **telegram-bot-api** (в контейнерах) — их не трогаем.
Проверка 26.09.2026 (`check.sh`): Docker 29.7 + Compose 5.5 есть, порты 80/443 свободны, IP `152.53.17.135`, все внешние API доступны.

Что будет на сервере:
- **конвейер аналитики** (`pipeline`) — запускается командой, работает в фоне, пишет отчёты в `/opt/vvriters/data/runs`;
- **страница с отчётами** (Caddy) — `https://152-53-17-135.sslip.io` под логином и паролем, HTTPS автоматически.

Все команды — на сервере под `root`, **не внутри контейнера Hermes**.

---

## Шаг 1. Swap (один раз)
```bash
curl -fsSL https://raw.githubusercontent.com/vvriters-hash/vvriters/claude/youthful-davinci-k0rx6v/deploy/setup.sh -o setup.sh
bash setup.sh
free -h        # в строке Swap должно быть 4.0Gi
```
Скрипт включает swap 4 ГБ и создаёт `/opt/vvriters`. Docker у тебя уже есть — пропустит. Docker не перезапускает, Hermes не трогает.

## Шаг 2. Скачать проект
```bash
git clone -b claude/youthful-davinci-k0rx6v https://github.com/vvriters-hash/vvriters.git /opt/vvriters/app
cd /opt/vvriters/app
```

## Шаг 3. Файл с настройками
```bash
cp deploy/.env.example /opt/vvriters/.env
chmod 600 /opt/vvriters/.env
mkdir -p /opt/vvriters/data/runs /opt/vvriters/data/briefs
```
Ключи API впишем позже (шаг 7). **Не присылай ключи в чат.**

## Шаг 4. Пароль для страницы с отчётами
Придумай пароль и получи его хэш:
```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'ТВОЙ_ПАРОЛЬ'
```
Скопируй строку, которая начинается с `$2a$…`, открой настройки:
```bash
nano /opt/vvriters/.env
```
и впиши её **в одинарных кавычках**: `REPORTS_PASSWORD_HASH='$2a$14$...'`. Логин — `REPORTS_USER` (по умолчанию `vvriters`). Сохранить: `Ctrl+O`, `Enter`, выйти: `Ctrl+X`.

## Шаг 5. Собрать и запустить
```bash
cd /opt/vvriters/app
docker compose -f deploy/docker-compose.yml --profile cli build pipeline
docker compose -f deploy/docker-compose.yml up -d reports
```
Сборка займёт 3–5 минут. Открой `https://152-53-17-135.sslip.io` — браузер спросит логин и пароль, после входа будет пустой список (отчётов пока нет).

## Шаг 6. Тестовый прогон без ключей
```bash
sed -i 's/^MOCK=0/MOCK=1/' /opt/vvriters/.env
./deploy/vv run --text "Кофейня в Тбилиси, рилсы для русскоязычных релокантов" --count 5 --name "проверка стенда"
```
Через несколько секунд на странице с отчётами появится папка с `report.html` — отчёт на выдуманных данных. Значит, стенд работает.
Вернуть боевой режим: `sed -i 's/^MOCK=1/MOCK=0/' /opt/vvriters/.env`.

## Шаг 7. Ключи и первый настоящий прогон
Когда появятся ключи (Anthropic, OpenAI, ScrapeCreators) — впиши их в `/opt/vvriters/.env` через `nano`, затем:
```bash
./deploy/vv check                       # все пункты должны быть ✔
./deploy/vv analyze-url https://www.tiktok.com/@user/video/123   # один ролик — дёшево, для проверки
```
Бриф из файлов: положи их в `/opt/vvriters/data/briefs/` (например, через `scp` или `nano`) и запусти:
```bash
./deploy/vv run --brief /data/briefs/бриф.txt --brief /data/briefs/голосовое.ogg --count 10
```
> Внутри контейнера папка `/opt/vvriters/data` видна как `/data` — поэтому пути в команде начинаются с `/data/briefs/…`.

Задача работает в фоне: можно закрыть SSH. Вернуться к логу — `./deploy/vv logs`. Отчёт появится на странице с отчётами.

## Обновление до новой версии
```bash
cd /opt/vvriters/app && ./deploy/update.sh
```

---

## Бюджет памяти
| Компонент | Лимит |
|---|---|
| Конвейер (Node.js + ffmpeg) | 1,2 ГБ (+ swap) |
| Caddy | 128 МБ |
| **Итого** | ~1,3 ГБ + swap 4 ГБ как страховка |

- Одновременно — один прогон, внутри него 2 ролика параллельно (`VIDEO_CONCURRENCY=2`).
- Видео удаляется сразу после анализа; остаются кадры, расшифровка и отчёт.
- Логи контейнеров ограничены 3 × 10 МБ.

## Адрес без своего домена
`152-53-17-135.sslip.io` — бесплатный адрес по IP. **До закрытой беты** лучше купить домен (~$10–15 в год): поменять `SITE_ADDRESS` в `.env` и выполнить `docker compose -f deploy/docker-compose.yml up -d reports`.

## Если что-то пошло не так
- `./deploy/vv check` — что настроено, а что нет.
- `docker compose -f deploy/docker-compose.yml logs reports` — логи страницы с отчётами.
- Страница не открывается: проверь, что порты 80 и 443 не закрыты файрволом у хостера.
- Сырые ответы провайдера данных сохраняются в папке прогона `raw/` — пришли мне название папки, если разбор получился странным.
