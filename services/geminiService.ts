
import { GoogleGenAI, Type } from "@google/genai";
import { SummaryResult, FileData } from '../types';

export const summarizeDocuments = async (files: FileData[], folderUrl: string): Promise<SummaryResult> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
  const model = "gemini-3-pro-preview";
  
  // Ограничиваем количество файлов для стабильности контекста (например, первые 15)
  const processedFiles = files.slice(0, 15);

  const fileParts = processedFiles.map(file => ({
    inlineData: {
      data: file.data,
      mimeType: file.mimeType
    }
  }));

  const textPart = {
    text: `
      Ты — эксперт-аналитик. Проанализируй содержимое этой папки: ${folderUrl}
      
      Тебе предоставлены файлы (изображения, PDF, документы).
      Инструкции:
      1. Проведи OCR (оптическое распознавание символов) для всех изображений (JPG, PNG, WEBP).
      2. Проанализируй текст во всех PDF-файлах.
      3. Объедини всю найденную информацию в единое структурированное резюме.
      4. Найди связи между разными файлами.
      
      ОТВЕТЬ СТРОГО НА РУССКОМ ЯЗЫКЕ.
    `
  };

  const response = await ai.models.generateContent({
    model: model,
    contents: [{ parts: [textPart, ...fileParts] }],
    config: {
      temperature: 0.2, // Снижаем температуру для более точного анализа фактов
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
            description: "Глубокое резюме всей папки."
          },
          keyPoints: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Основные факты и данные, извлеченные из документов."
          },
          mainTopics: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Ключевые темы."
          },
          sentiment: {
            type: Type.STRING,
            description: "Общий характер информации."
          }
        },
        required: ["summary", "keyPoints", "mainTopics", "sentiment"]
      }
    }
  });

  const resultText = response.text || '{}';
  try {
    return JSON.parse(resultText) as SummaryResult;
  } catch (e) {
    console.error("Ошибка ИИ:", resultText);
    throw new Error("ИИ вернул некорректный формат данных. Попробуйте еще раз.");
  }
};
