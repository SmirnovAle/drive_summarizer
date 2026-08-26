# 🧠 DriveSummary Pro

**DriveSummary Pro** — веб-приложение для анализа и суммаризации содержимого публичных папок Google Drive с помощью Gemini.

## 🚀 Основные возможности

- Получение поддерживаемых файлов через Google Drive API v3.
- Анализ текста, PDF, офисных документов и изображений.
- Структурированный итог: summary, key points, topics и sentiment.
- React 19 + TypeScript frontend; Express backend; Gemini через `@google/genai`.

## 🔐 Security model

Все Google credentials являются **backend-only secrets**. Frontend обращается только к same-origin `/api/*` endpoints.

Никогда не передавайте `GEMINI_API_KEY`, `GOOGLE_DRIVE_API_KEY` или другие секреты через Vite `define`, `import.meta.env`, frontend source code или browser bundle. `.env` и `.env.local` должны оставаться в `.gitignore`; в Git разрешён только placeholder-only `.env.example`.

Все `/api/*` endpoints защищены HTTP Basic Authentication. В production сервер не запускается без `APP_AUTH_USERNAME` и `APP_AUTH_PASSWORD`. `/api/summarize` дополнительно имеет per-IP rate limiting и ограничения размера payload/files.

## 📦 Настройка

Скопируйте `.env.example` в `.env` на сервере и задайте реальные значения только в server environment. Для production обязательно задайте сильные уникальные `APP_AUTH_USERNAME` и `APP_AUTH_PASSWORD`.

Основные переменные:

- `GEMINI_API_KEY` — backend-only Gemini key.
- `GOOGLE_DRIVE_API_KEY` — backend-only Drive key.
- `APP_AUTH_USERNAME`, `APP_AUTH_PASSWORD` — доступ к `/api/*`.
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS` — лимит `/api/summarize`.
- `MAX_JSON_BODY_MB`, `MAX_FILES`, `MAX_FILE_ENCODED_MB`, `MAX_TOTAL_ENCODED_MB` — payload limits.
- `GEMINI_PROXY` — optional SOCKS5 proxy.
- `PORT` — application port.

## 🚨 Key rotation / incident deployment

После подозрения на компрометацию ключа:

1. Revoke/delete старый Gemini key.
2. Создайте новый key с минимально необходимыми API restrictions.
3. Установите новый `GEMINI_API_KEY` только в backend/server environment.
4. Настройте `APP_AUTH_USERNAME` и сильный `APP_AUTH_PASSWORD`.
5. Соберите и задеплойте приложение, затем перезапустите backend.
6. Проверьте browser JS/assets: Gemini/Google API keys и имена backend secrets не должны присутствовать в bundle.
7. Проверьте, что запрос к `/api/*` без credentials получает `401`, корректно аутентифицированный запрос работает, а rate limit возвращает `429` при превышении.
8. Проверьте Google Cloud API metrics/billing после ротации.

Не записывайте реальные ключи в README, `.env.example`, логи, issues или PR.

## 📖 Использование

После прохождения HTTP Basic Authentication вставьте ссылку на публичную папку Google Drive и запустите сканирование/анализ. Поддерживается также существующий ручной workflow загрузки файлов.

## 🏗 Основные модули

- `services/driveService.ts` — frontend workflow Google Drive.
- `services/geminiService.ts` — same-origin обращение к backend summarization API.
- `server.ts` — Drive access, extraction, Gemini inference и security controls.
- `types.ts` — типы приложения.

## 📄 Лицензия

MIT.
