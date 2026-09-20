# Nexus Messenger

Современный мессенджер в реальном времени.

## Как задеплоить на Render.com

1. Создай репозиторий на GitHub и загрузи все файлы этой папки.
2. Зайди на https://dashboard.render.com
3. New → Web Service
4. Подключи свой GitHub репозиторий
5. Настройки:
   - Name: nexus-messenger (любое)
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free
6. Нажми Create Web Service

После деплоя получишь ссылку вида https://nexus-messenger-xxxx.onrender.com
