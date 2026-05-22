# Ручной запуск Codex Notification Bot

Этот проект больше не должен запускаться автоматически после включения ноутбука.
Автозапуск отключен через пользовательский `systemd` service:
`codex-notification-bot.service`.

## Проверить, что бот выключен

```bash
systemctl --user status codex-notification-bot.service --no-pager
```

Показывает текущее состояние сервиса. Если бот выключен, в выводе будет
`inactive (dead)`.

```bash
systemctl --user is-enabled codex-notification-bot.service
```

Показывает, включен ли автозапуск. Для ручного режима должно быть `disabled`.

## Запустить бота вручную

```bash
systemctl --user start codex-notification-bot.service
```

Запускает Telegram-бота вручную через `systemd`. После этого бот будет работать
в фоне, пока его не остановить или пока не выключится пользовательская сессия.

## Остановить бота

```bash
systemctl --user stop codex-notification-bot.service
```

Останавливает работающий процесс бота.

## Перезапустить бота

```bash
systemctl --user restart codex-notification-bot.service
```

Останавливает бота и сразу запускает заново. Удобно после изменения настроек
или обновления кода.

## Смотреть логи

```bash
journalctl --user -u codex-notification-bot.service -f
```

Показывает живые логи сервиса. Остановить просмотр можно через `Ctrl+C`.

## После изменения кода

```bash
cd /home/sanzh/Documents/Projects/codex-notification-bot
npm run build
systemctl --user restart codex-notification-bot.service
```

`npm run build` собирает TypeScript-код в `dist`, а `restart` запускает новую
собранную версию бота.

## Запуск без systemd

```bash
cd /home/sanzh/Documents/Projects/codex-notification-bot
npm start
```

Запускает бота прямо в текущем терминале. В этом режиме бот работает только пока
открыт процесс. Остановить можно через `Ctrl+C`.

## Не включать автозапуск

```bash
systemctl --user enable codex-notification-bot.service
```

Эта команда снова включит автозапуск. Для ручного режима ее использовать не
нужно.
