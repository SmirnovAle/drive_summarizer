
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

// Настройка прокси для Gemini API
const proxy = process.env.GEMINI_PROXY;
if (proxy) {
  console.log(`Using proxy for Gemini API: ${proxy}`);
  const agent = new SocksProxyAgent(proxy);
  const originalFetch = global.fetch;
  // @ts-ignore
  global.fetch = (url: any, options: any) => {
    return fetch(url, {
      ...options,
      agent: agent
    }) as any;
  };
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
      const listResponse = await fetch(listUrl);
      
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
          const contentResponse = await fetch(contentUrl);
          
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

  // API Endpoint для суммаризации
  app.post('/api/summarize', async (req, res) => {
    try {
      const { files, folderUrl } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on server' });
      }

      const ai = new GoogleGenAI({ apiKey });
      
      const fileParts = files.map((f: any) => ({
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

      const result = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              ...fileParts
            ]
          }
        ]
      });

      const responseText = result.text || '{}';
      
      // Очистка от markdown-оберток, если они есть
      const cleanJson = responseText.replace(/```json|```/g, '').trim();
      res.json(JSON.parse(cleanJson));
    } catch (error: any) {
      console.error('Server error:', error);
      res.status(500).json({ error: error.message });
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
