# BTC 5M Server Bot

Серверный бот который работает 24/7 и пишет данные в Firebase.

## Деплой на Render.com (бесплатно)

### Шаг 1 — Firebase Service Account
1. Открой Firebase Console → Project Settings → Service Accounts
2. Нажми "Generate new private key"
3. Скачается JSON файл — он нам нужен

### Шаг 2 — GitHub репозиторий
1. Создай новый репозиторий на GitHub (отдельный от сайта)
2. Загрузи файлы: bot.js, package.json
3. НЕ загружай .env файл с секретами!

### Шаг 3 — Render.com
1. Открой render.com → Sign up (через GitHub)
2. New → Web Service → Connect GitHub repo
3. Settings:
   - Build Command: npm install
   - Start Command: npm start
   - Instance Type: Free
4. Environment Variables — добавь:
   - FIREBASE_PROJECT_ID = btc-bot884
   - FIREBASE_DATABASE_URL = https://btc-bot884-default-rtdb.firebaseio.com
   - FIREBASE_CLIENT_EMAIL = (из JSON файла поле "client_email")
   - FIREBASE_PRIVATE_KEY = (из JSON файла поле "private_key")
5. Deploy!

### Шаг 4 — Управление ботом
- Запуск/стоп: прямо с сайта кнопками Старт/Стоп
- Сброс: кнопка ↺ на сайте
- Логи: в Render.com → Logs

## Как получить Firebase credentials

В скачанном JSON файле:
- client_email → FIREBASE_CLIENT_EMAIL
- private_key  → FIREBASE_PRIVATE_KEY
- project_id   → FIREBASE_PROJECT_ID
