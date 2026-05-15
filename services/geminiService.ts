
import { SummaryResult, FileData } from '../types';

export const summarizeDocuments = async (files: FileData[], folderUrl: string): Promise<SummaryResult> => {
  // Ограничиваем количество файлов для стабильности контекста (например, первые 15)
  const processedFiles = files.slice(0, 15);

  try {
    const response = await fetch('/api/summarize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: processedFiles,
        folderUrl
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Ошибка сервера при анализе');
    }

    return await response.json();
  } catch (error: any) {
    console.error("AI Error:", error);
    throw new Error(error.message || "Ошибка при подключении к ИИ-сервису.");
  }
};
