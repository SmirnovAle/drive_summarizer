
import { FileData } from '../types';


export const extractFolderId = (url: string): string | null => {
  // Поддержка форматов:
  // - drive.google.com/drive/folders/ID
  // - drive.google.com/drive/u/0/folders/ID
  // - drive.google.com/open?id=ID
  const patterns = [
    /folders\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1];
  }

  return null;
};

export const fetchFolderFiles = async (folderId: string): Promise<FileData[]> => {
  try {
    const response = await fetch('/api/drive/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ folderId }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Ошибка Drive API: ${response.statusText || 'Unknown'}`);
    }

    return await response.json();
  } catch (error: any) {
    console.error("Drive Error:", error);
    throw error;
  }
};
