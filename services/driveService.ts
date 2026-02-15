
import { FileData } from '../types';

const DRIVE_API_KEY = process.env.API_KEY;

export const extractFolderId = (url: string): string | null => {
  const match = url.match(/folders\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
};

export const fetchFolderFiles = async (folderId: string): Promise<FileData[]> => {
  if (!DRIVE_API_KEY) throw new Error("Критическая ошибка: API Key не настроен.");

  try {
    // 1. Получаем список файлов
    const listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType)&key=${DRIVE_API_KEY}`;
    const listResponse = await fetch(listUrl);
    
    if (!listResponse.ok) {
      if (listResponse.status === 403) throw new Error("Доступ к папке ограничен или превышена квота API.");
      throw new Error(`Ошибка Drive API: ${listResponse.statusText}`);
    }
    
    const listData = await listResponse.json();
    if (!listData.files || listData.files.length === 0) return [];

    const files: FileData[] = [];

    // 2. Скачиваем контент
    for (const file of listData.files) {
      try {
        const contentUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&key=${DRIVE_API_KEY}`;
        const contentResponse = await fetch(contentUrl);
        
        if (!contentResponse.ok) {
          console.warn(`Файл ${file.name} не может быть скачан напрямую (CORS или размер).`);
          continue;
        }

        const blob = await contentResponse.blob();
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(blob);
        });

        files.push({
          name: file.name,
          data: base64,
          mimeType: file.mimeType,
          size: blob.size
        });
      } catch (e) {
        console.error(`Ошибка при загрузке ${file.name}:`, e);
      }
    }

    if (files.length === 0 && listData.files.length > 0) {
      throw new Error("Файлы найдены, но браузер заблокировал их скачивание (CORS). Пожалуйста, загрузите их вручную.");
    }

    return files;
  } catch (error: any) {
    console.error("Drive Error:", error);
    throw error;
  }
};
