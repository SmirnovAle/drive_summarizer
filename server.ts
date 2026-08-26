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
import { createRequire } from 'module';
import crypto from 'crypto';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const intEnv = (name: string, fallback: number, min = 1) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
};

const MB = 1024 * 1024;
const MAX_JSON_BODY_MB = intEnv('MAX_JSON_BODY_MB', 20);
const MAX_FILES = intEnv('MAX_FILES', 30);
const MAX_FILE_ENCODED_MB = intEnv('MAX_FILE_ENCODED_MB', 20);
const MAX_TOTAL_ENCODED_MB = intEnv('MAX_TOTAL_ENCODED_MB', 40);
const RATE_LIMIT_WINDOW_MS = intEnv('RATE_LIMIT_WINDOW_MS', 60_000);
const RATE_LIMIT_MAX_REQUESTS = intEnv('RATE_LIMIT_MAX_REQUESTS', 10);

const proxy = process.env.GEMINI_PROXY;
const agent = proxy ? new SocksProxyAgent(proxy) : undefined;
const proxyFetch = (url: string, options: any = {}) => fetch(url, { ...options, agent }) as any;
if (proxy) {
  console.log('[Proxy] SOCKS5 proxy enabled');
  // @ts-ignore
  global.fetch = proxyFetch;
}

const safeEqual = (actual: string, expected: string) => {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const authenticateApi: express.RequestHandler = (req, res, next) => {
  const username = process.env.APP_AUTH_USERNAME || '';
  const password = process.env.APP_AUTH_PASSWORD || '';
  if (!username || !password) {
    return res.status(503).json({ error: 'API authentication is not configured' });
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="DriveSummary Pro"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) throw new Error('invalid');
    const suppliedUser = decoded.slice(0, separator);
    const suppliedPassword = decoded.slice(separator + 1);
    if (!safeEqual(suppliedUser, username) || !safeEqual(suppliedPassword, password)) throw new Error('invalid');
    next();
  } catch {
    res.setHeader('WWW-Authenticate', 'Basic realm="DriveSummary Pro"');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
};

type RateEntry = { count: number; resetAt: number };
const summarizeRates = new Map<string, RateEntry>();
const summarizeRateLimit: express.RequestHandler = (req, res, next) => {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  let entry = summarizeRates.get(key);
  if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  entry.count += 1;
  summarizeRates.set(key, entry);
  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - entry.count);
  res.setHeader('RateLimit-Limit', RATE_LIMIT_MAX_REQUESTS.toString());
  res.setHeader('RateLimit-Remaining', remaining.toString());
  res.setHeader('RateLimit-Reset', Math.ceil(entry.resetAt / 1000).toString());
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetAt - now) / 1000)).toString());
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
};
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of summarizeRates) if (entry.resetAt <= now) summarizeRates.delete(key);
}, RATE_LIMIT_WINDOW_MS).unref();

async function extractText(mimeType: string, buffer: Buffer, fileName: string): Promise<string> {
  try {
    if (mimeType.includes('text/') || mimeType.includes('json') || mimeType.includes('xml')) return buffer.toString('utf-8');
    if (mimeType === 'application/pdf') return (await pdf(buffer)).text;
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return (await mammoth.extractRawText({ buffer })).value;
    if (['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel','application/vnd.oasis.opendocument.spreadsheet','text/csv'].includes(mimeType)) {
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      return workbook.SheetNames.map(name => `Sheet: ${name}\n${xlsx.utils.sheet_to_txt(workbook.Sheets[name])}`).join('\n');
    }
    if (mimeType.startsWith('image/')) return '';
    return buffer.toString('utf-8').slice(0, 50000);
  } catch {
    console.error(`[Extract] Failed to extract ${fileName}`);
    return `[Ошибка извлечения текста из ${fileName}]`;
  }
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && (!process.env.APP_AUTH_USERNAME || !process.env.APP_AUTH_PASSWORD)) {
    throw new Error('APP_AUTH_USERNAME and APP_AUTH_PASSWORD are required in production');
  }

  const allowedOrigins = new Set([
    'https://drive-summarizer.ai-smirnov.ru',
    'http://localhost:3000', 'http://127.0.0.1:3000',
    'http://localhost:5173', 'http://127.0.0.1:5173'
  ]);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed by CORS'));
    }
  }));
  app.use(express.json({ limit: `${MAX_JSON_BODY_MB}mb` }));
  app.use('/api', authenticateApi);

  app.post('/api/drive/files', async (req, res) => {
    try {
      const { folderId } = req.body || {};
      const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'GOOGLE_DRIVE_API_KEY не настроен на сервере' });
      if (typeof folderId !== 'string' || !folderId.trim()) return res.status(400).json({ error: 'ID папки не указан' });

      const searchParams = new URLSearchParams({ q: `'${folderId}' in parents and trashed=false`, fields: 'files(id,name,mimeType)', key: apiKey });
      const listResponse = await proxyFetch(`https://www.googleapis.com/drive/v3/files?${searchParams.toString()}`);
      if (!listResponse.ok) {
        if (listResponse.status === 404) return res.status(404).json({ error: 'Папка не найдена или неверный ID' });
        if (listResponse.status === 403) return res.status(403).json({ error: 'Доступ запрещен. Убедитесь, что папка доступна всем, у кого есть ссылка' });
        if (listResponse.status === 429) return res.status(429).json({ error: 'Превышена квота Google Drive API' });
        return res.status(listResponse.status).json({ error: 'Ошибка Drive API' });
      }
      const listData: any = await listResponse.json();
      if (!Array.isArray(listData.files) || listData.files.length === 0) return res.json([]);

      const supportedMimeTypes = [
        'application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel',
        'application/vnd.oasis.opendocument.spreadsheet','text/csv','application/rtf','text/rtf',
        'image/jpeg','image/png','image/webp','image/heic','image/heif','text/plain','text/markdown',
        'text/html','application/json','application/xml','text/xml','application/x-yaml','text/yaml','text/x-log'
      ];
      const files: any[] = [];
      const MAX_DRIVE_FILE_SIZE = 15 * MB;
      for (const file of listData.files) {
        const name = typeof file.name === 'string' ? file.name : '';
        const mimeType = typeof file.mimeType === 'string' ? file.mimeType : '';
        const supported = supportedMimeTypes.some(type => mimeType.includes(type)) || /\.(md|log|ya?ml)$/i.test(name);
        if (!supported) continue;
        try {
          const contentResponse = await proxyFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&key=${apiKey}`);
          if (!contentResponse.ok) continue;
          const buffer = Buffer.from(await contentResponse.arrayBuffer());
          if (buffer.length > MAX_DRIVE_FILE_SIZE) continue;
          let data = '';
          let finalMimeType = mimeType;
          if (mimeType.startsWith('image/')) data = buffer.toString('base64');
          else {
            data = Buffer.from(await extractText(mimeType, buffer, name)).toString('base64');
            finalMimeType = 'text/plain';
          }
          if (data.length >= 5) files.push({ id: file.id, name, data, mimeType: finalMimeType, size: buffer.byteLength });
        } catch { console.error(`[Drive] Failed to process ${name}`); }
      }
      if (files.length === 0 && listData.files.length > 0) return res.status(400).json({ error: 'В папке нет поддерживаемых типов файлов или они слишком большие/пустые' });
      res.json(files);
    } catch {
      console.error('[Drive] Unexpected server error');
      res.status(500).json({ error: 'Внутренняя ошибка сервера при работе с Google Drive' });
    }
  });

  app.post('/api/summarize', summarizeRateLimit, async (req, res) => {
    try {
      const { files, folderUrl } = req.body || {};
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY не настроен на сервере' });
      if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'files must be a non-empty array' });
      if (files.length > MAX_FILES) return res.status(413).json({ error: 'Too many files' });
      if (folderUrl !== undefined && typeof folderUrl !== 'string') return res.status(400).json({ error: 'Invalid folderUrl' });

      const allowedMime = /^(text\/|image\/|application\/(pdf|json|xml|rtf|vnd\.|x-yaml))/;
      let totalEncoded = 0;
      for (const file of files) {
        if (!file || typeof file !== 'object' || typeof file.data !== 'string' || typeof file.mimeType !== 'string') return res.status(400).json({ error: 'Invalid file payload' });
        if (!allowedMime.test(file.mimeType)) return res.status(400).json({ error: 'Unsupported MIME type' });
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) || file.data.length % 4 !== 0) return res.status(400).json({ error: 'Invalid Base64 content' });
        if (file.data.length > MAX_FILE_ENCODED_MB * MB) return res.status(413).json({ error: 'File payload too large' });
        totalEncoded += file.data.length;
        if (totalEncoded > MAX_TOTAL_ENCODED_MB * MB) return res.status(413).json({ error: 'Total payload too large' });
      }

      const ai = new GoogleGenAI({ apiKey });
      const fileParts = files.map((f: any) => ({ inlineData: { data: f.data, mimeType: f.mimeType } }));
      const prompt = `Ты — аналитический ИИ-ассистент FolderMind.\nПеред тобой файлы из папки Google Drive (URL: ${folderUrl || ''}).\nПроанализируй их содержимое и составь краткий, но информативный отчет.\nОТВЕТЬ СТРОГО В ФОРМАТЕ JSON:\n{"summary":"Глубокое резюме всей папки.","keyPoints":["Важный пункт 1"],"mainTopics":["Ключевая тема 1"],"sentiment":"neutral | positive | negative"}`;
      const response = await ai.models.generateContent({ model: 'gemini-3-flash-preview', contents: { parts: [{ text: prompt }, ...fileParts] } });
      const cleanJson = (response.text || '{}').replace(/```json|```/g, '').trim();
      res.json(JSON.parse(cleanJson));
    } catch (error: any) {
      console.error('[Gemini] Request failed');
      if (error?.message?.includes('API key not valid')) return res.status(401).json({ error: 'Ключ Gemini API недействителен' });
      if (error?.message?.includes('User location is not supported')) return res.status(403).json({ error: 'Регион не поддерживается. Проверьте GEMINI_PROXY.' });
      res.status(500).json({ error: 'Внутренняя ошибка при анализе ИИ' });
    }
  });

  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON' });
    if (err?.message === 'Origin not allowed by CORS') return res.status(403).json({ error: 'Origin not allowed' });
    next(err);
  });

  if (!isProduction) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.use((req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`Server running at http://0.0.0.0:${PORT}`));
}

startServer().catch(error => {
  console.error('[Startup] Server failed to start:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
