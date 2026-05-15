
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';
import cors from 'cors';
import fetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Настройка прокси
const proxy = process.env.GEMINI_PROXY;
const agent = proxy ? new SocksProxyAgent(proxy) : undefined;

// Вспомогательная функция для запросов с поддержкой прокси
const proxyFetch = (url: string, options: any = {}) => {
  return fetch(url, {
    ...options,
    agent: agent
  }) as any;
};

// Патч глобального fetch для библиотек, которые его используют
if (proxy) {
  console.log(`[Proxy] Using SOCKS5 proxy: ${proxy}`);
  // @ts-ignore
  global.fetch = proxyFetch;
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // API Endpoint для получения файлов из Google Drive
  app.post('/api/drive/files', async (req, res) => {
    try {
      const { folderId } = req.body;
      const apiKey = process.env.GOOGLE_DRIVE_API_KEY;

      if (!apiKey) {
        console.error('[Drive] GOOGLE_DRIVE_API_KEY is missing in environment');
        return res.status(500).json({ error: 'GOOGLE_DRIVE_API_KEY не настроен на сервере' });
      }

      if (!folderId) {
        console.error('[Drive] folderId is missing in request body');
        return res.status(400).json({ error: 'ID папки не указан' });
      }

      console.log(`[Drive] Fetching files for folder: ${folderId}`);

      // 1. Получаем список файлов
      const query = `'${folderId}' in parents and trashed=false`;
      const searchParams = new URLSearchParams({
        q: query,
        fields: 'files(id,name,mimeType)',
        key: apiKey
      });
      
      const listUrl = `https://www.googleapis.com/drive/v3/files?${searchParams.toString()}`;
      const listResponse = await proxyFetch(listUrl);
      
      if (!listResponse.ok) {
        const errorText = await listResponse.text();
        console.error('[Drive] List Error:', listResponse.status, errorText);
        
        if (listResponse.status === 404) {
          return res.status(404).json({ error: 'Папка не найдена или неверный ID' });
        }
        if (listResponse.status === 403) {
          return res.status(403).json({ error: 'Доступ запрещен. Убедитесь, что папка «Доступна всем, у кого есть ссылка»' });
        }
        if (listResponse.status === 429) {
          return res.status(429).json({ error: 'Превышена квота Google Drive API' });
        }
        
        return res.status(listResponse.status).json({ error: `Ошибка Drive API: ${listResponse.statusText || 'Unknown Error'}` });
      }
      
      const listData: any = await listResponse.json();
      if (!listData.files || listData.files.length === 0) {
        console.log(`[Drive] Folder ${folderId} is empty`);
        return res.json([]);
      }

      console.log(`[Drive] Found ${listData.files.length} files. Filtering and downloading...`);

      const files: any[] = [];
      const supportedMimeTypes = [
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp',
        'text/plain',
        'text/markdown',
        'application/json'
      ];

      // 2. Скачиваем контент
      for (const file of listData.files) {
        if (!supportedMimeTypes.includes(file.mimeType)) {
          console.log(`[Drive] Skipping unsupported file: ${file.name} (${file.mimeType})`);
          continue;
        }

        try {
          const contentUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&key=${apiKey}`;
          const contentResponse = await proxyFetch(contentUrl);
          
          if (!contentResponse.ok) {
            console.warn(`[Drive] Could not download ${file.name}: ${contentResponse.statusText}`);
            continue;
          }

          const buffer = await contentResponse.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');

          files.push({
            id: file.id,
            name: file.name,
            data: base64,
            mimeType: file.mimeType,
            size: buffer.byteLength
          });
          console.log(`[Drive] Downloaded: ${file.name} (${buffer.byteLength} bytes)`);
        } catch (e) {
          console.error(`[Drive] Error downloading ${file.name}:`, e);
        }
      }

      if (files.length === 0 && listData.files.length > 0) {
        return res.status(400).json({ error: 'В папке нет поддерживаемых типов файлов (PDF, PNG, JPG, TXT)' });
      }

      res.json(files);
    } catch (error: any) {
      console.error('[Drive] Unexpected Server Error:', error);
      res.status(500).json({ error: 'Внутренняя ошибка сервера при работе с Google Drive' });
    }
  });

  // API Endpoint для суммаризации (Gemini)
  app.post('/api/summarize', async (req, res) => {
    try {
      const { files, folderUrl } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;
      const driveKey = process.env.GOOGLE_DRIVE_API_KEY;

      // Логирование состояния ключей (без вывода полных значений)
      console.log('--- [Auth Debug] ---');
      console.log(`[Gemini] Key present: ${!!apiKey}`);
      if (apiKey) {
        console.log(`[Gemini] Key length: ${apiKey.length}`);
        console.log(`[Gemini] Key prefix: ${apiKey.substring(0, 6)}...`);
      }
      console.log(`[Drive]  Key present: ${!!driveKey}`);
      if (driveKey) {
        console.log(`[Drive]  Key length: ${driveKey.length}`);
        console.log(`[Drive]  Key prefix: ${driveKey.substring(0, 6)}...`);
      }
      console.log(`[Proxy]  Using proxy: ${!!proxy}`);
      console.log('--------------------');

      if (!apiKey) {
        console.error('[Gemini] GEMINI_API_KEY is not configured');
        return res.status(500).json({ error: 'GEMINI_API_KEY не настроен на сервере' });
      }

      console.log(`[Gemini] Starting analysis for ${files?.length} files...`);

      // Инициализация SDK. 
      // Примечание: @google/genai использует глобальный fetch, 
      // который мы пропатчили для использования SOCKS5 прокси.
      const ai = new GoogleGenAI({ apiKey });
      
      const fileParts = (files || []).map((f: any) => ({
        inlineData: {
          data: f.data,
          mimeType: f.mimeType
        }
      }));

      const prompt = `Ты — аналитический ИИ-ассистент FolderMind. 
      Перед тобой файлы из папки Google Drive (URL: ${folderUrl}).
      Проанализируй их содержимое (текст, PDF, изображения) и составь краткий, но информативный отчет.
      Используй структурированный формат.
      
      ОТВЕТЬ СТРОГО В ФОРМАТЕ JSON:
      {
        "summary": "Глубокое резюме всей папки.",
        "keyPoints": ["Важный пункт 1", "Важный пункт 2"],
        "mainTopics": ["Ключевая тема 1", "Ключевая тема 2"],
        "sentiment": "neutral | positive | negative"
      }`;

      // Модель gemini-3-flash-preview (или gemini-1.5-flash как запасной вариант для стандартных ключей)
      // В AI Studio Build мы используем gemini-3-flash-preview.
      const modelName = "gemini-3-flash-preview";
      console.log(`[Gemini] Calling model: ${modelName}`);

      const response = await ai.models.generateContent({
        model: modelName,
        contents: {
          parts: [
            { text: prompt },
            ...fileParts
          ]
        }
      });

      const responseText = response.text || '{}';
      console.log('[Gemini] Analysis complete');

      // Очистка от markdown-оберток
      const cleanJson = responseText.replace(/```json|```/g, '').trim();
      res.json(JSON.parse(cleanJson));

    } catch (error: any) {
      console.error('[Gemini] API Error:', error);
      
      // Перехват типичных ошибок ключа
      if (error.message?.includes('API key not valid')) {
        return res.status(401).json({ 
          error: 'Ключ Gemini API недействителен (API_KEY_INVALID). Проверьте GEMINI_API_KEY.' 
        });
      }

      if (error.message?.includes('User location is not supported')) {
        return res.status(403).json({ 
          error: 'Регион не поддерживается. Убедитесь, что GEMINI_PROXY настроен верно.' 
        });
      }

      res.status(500).json({ error: error.message || 'Внутренняя ошибка при анализе ИИ' });
    }
  });

  // Интеграция Vite (Development) или статика (Production)
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // SPA fallback для Express 5+
    app.use((req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
