# Минимальное подключение MCP

`server.mjs` запускает HTTP MCP-сервер с инструментами `ping`, `server_time` и
`get_weather`. Последний принимает `city`, находит город через
[Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api) и получает
[текущую погоду](https://open-meteo.com/en/docs). `list-tools.mjs` подключается к
серверу, вызывает `listTools()` и печатает имена, описания и схемы аргументов.
`get-weather.mjs` вызывает погодный инструмент через MCP. Инструменты
`schedule_weather_collection` и `get_weather_summary` — планировщик погоды,
описанный [ниже](#планировщик-погоды-день-18). `find_concert` ищет по локальной
афише (`concerts.mjs`), где выступает исполнитель. `concert-weather.mjs`
выполняет цепочку `find_concert` → `get_weather` через MCP:
`npm run mcp:concert-weather -- Нюша`.

Из корня проекта:

```bash
npm run mcp:server
npm run mcp:list
npm run mcp:weather -- Москва
```

Сервер принимает запросы только на `127.0.0.1:8765/mcp`. Другой порт можно
задать через `MCP_PORT`, а URL клиента — через `MCP_SERVER_URL`.

На удалённой машине установите Node.js 22.13+, скопируйте каталог `scripts/mcp`,
выполните в нём `npm ci --omit=dev` и запустите `server.mjs` как сервис. Пример
systemd-конфигурации — `ai-challenge-mcp.service`; в ней нужно подставить свой
путь к Node.js и системного пользователя. Для
проверки с рабочего компьютера пробросьте порт по SSH:

```bash
ssh -L 8765:127.0.0.1:8765 user@VPS_IP
npm run mcp:list
npm run mcp:weather -- Москва
```

Сервер намеренно не слушает публичный интерфейс: у этого учебного примера
нет авторизации. Не открывайте порт 8765 в интернет без HTTPS и проверки
доступа. Вызовы инструментов из чата выполняются сервером приложения.
Бесплатный API Open-Meteo рассчитан на
некоммерческое использование; условия для других сценариев нужно проверить
перед применением.

Экран «MCP Инструменты» в локальном чате получает живой список инструментов
через серверный маршрут `/api/mcp`. При запуске приложения через
`launch.command` или `start.sh` SSH-туннель открывается автоматически, если
найден `~/.ssh/ai-vps-key`. При запуске через `pnpm dev` откройте туннель
в отдельном терминале:

```bash
ssh -i ~/.ssh/ai-vps-key -N -L 127.0.0.1:18765:127.0.0.1:8765 user@VPS_IP
```

Держите его открытым, пока работает чат. Если туннель закрыт, экран показывает
статус «Недоступен» и позволяет повторить проверку. Для другого адреса MCP
можно задать серверную переменную `MCP_CAPSULE_URL`. Для другой SSH-капсулы
`start.sh` принимает `MCP_SSH_TARGET` и `MCP_SSH_KEY`.

## Планировщик погоды (день 18)

Планировщик состоит из двух частей, и обе работают на капсуле.

- **MCP-инструменты** в `handler.mjs`. `schedule_weather_collection` (аргументы
  `city`, `intervalMinutes`, `durationMinutes`) записывает задание в JSON и
  возвращает `jobId`. `get_weather_summary` с `jobId` отдаёт статус задания, его
  замеры и агрегат; с `date` — суточную сводку за этот день, без аргументов —
  последнюю суточную сводку и состояние планировщика. Таймеров внутри сервера
  нет.
- **cron** раз в минуту запускает `weather-tick.mjs` (строка — в
  `weather.crontab`). Скрипт делает только то, что пора: ежечасный замер для
  Москвы, суточную сводку в 16:00 МСК из замеров до 16:00 и замеры активных
  заданий по их интервалу. Погоду он получает через MCP `get_weather` на
  `127.0.0.1:8765`. Повторный или пропущенный запуск ничего не ломает: замер
  часа не дублируется, а пропущенные точки не выдумываются. При сбое ежечасный
  замер повторяется через 5 минут. `flock` не даёт запускам наложиться.

Данные лежат рядом с сервером в `data/`: `samples/ДАТА/ЧАС.json`,
`reports/ДАТА.json`, `jobs/ID.json` и `status.json` с состоянием планировщика.
Другой каталог задаётся через `WEATHER_DATA_DIR`. Признак дождя берётся из полей
`rain` и `showers`, а также из кода погоды; снег дождём не считается. Ключ
DeepSeek на капсуле не нужен: краткий вывод по итогам пишет модель в приложении.

Установка на капсулу (пути — как в `ai-challenge-mcp.service`):

```bash
scp -i ~/.ssh/ai-vps-key scripts/mcp/{server,handler,weather,weather-store,weather-jobs,weather-tick,concerts,concert-weather}.mjs scripts/mcp/weather.crontab scripts/mcp/ai-challenge-mcp.service user@VPS_IP:/home/user/mcp-demo/
```

На капсуле:

```bash
mkdir -p /home/user/mcp-demo/data
sudo cp /home/user/mcp-demo/ai-challenge-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart ai-challenge-mcp
(crontab -l 2>/dev/null | grep -v weather-tick.mjs | grep -vxF -f /home/user/mcp-demo/weather.crontab; cat /home/user/mcp-demo/weather.crontab) | crontab -
```

В unit добавлен `ReadWritePaths` для `data/`: без него `ProtectHome=read-only`
не даст MCP-серверу записать задание. Каталог должен существовать до
перезапуска службы. Проверка: через минуту в `data/tick.log` и `data/status.json`
появятся первые записи, а `npm run mcp:list` через туннель покажет пять
инструментов. Локально планировщик запускается командой `npm run weather:tick`
при работающем `npm run mcp:server`; данные пишутся в `scripts/mcp/data/`
(каталог в `.gitignore`).

В чате агент сам вызывает `schedule_weather_collection`, а приложение, пока
вкладка открыта, опрашивает `get_weather_summary` через `/api/weather`. После
окончания сбора оно добавляет в тот же чат таблицу замеров и вывод модели.
Результат хранится на капсуле, поэтому после повторного открытия вкладки он
тоже придёт. Автоматическая доставка работает в обычном чате агента; в режиме
задачи результат можно запросить у агента вопросом.
