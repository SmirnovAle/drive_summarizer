
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // API Endpoint для суммаризации
  app.post('/api/summarize', async (req, res) => {
    try {
      const { files, folderUrl } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on server' });
      }

      const ai = new GoogleGenAI(apiKey);
      const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });

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
        "title": "Заголовок отчета",
        "description": "Общее описание содержимого папки",
        "keyPoints": ["Важный пункт 1", "Важный пункт 2"],
        "sentiment": "neutral | positive | negative",
        "wordCount": 100
      }`;

      const result = await model.generateContent([prompt, ...fileParts]);
      const responseText = result.response.text();
      
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
