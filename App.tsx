
import React, { useState, useEffect } from 'react';
import { summarizeDocuments } from './services/geminiService';
import { extractFolderId, fetchFolderFiles } from './services/driveService';
import { SummaryResult, FileData, AppStatus } from './types';

const App: React.FC = () => {
  const [folderUrl, setFolderUrl] = useState('https://drive.google.com/drive/folders/1x6EKNkVw6PlFVTr6cGrsVscmRuwqGrXd?usp=sharing');
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [loadingStep, setLoadingStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileData[]>([]);

  // Основная функция инференса
  const runInference = async (filesToProcess: FileData[]) => {
    if (filesToProcess.length === 0) return;
    
    setStatus(AppStatus.LOADING);
    setLoadingStep(`Запуск ИИ-анализа ${filesToProcess.length} файлов...`);
    
    try {
      const result = await summarizeDocuments(filesToProcess, folderUrl);
      setSummary(result);
      setStatus(AppStatus.SUCCESS);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Ошибка ИИ при инференсе.");
      setStatus(AppStatus.ERROR);
    } finally {
      setLoadingStep('');
    }
  };

  const handleAutoScan = async () => {
    const folderId = extractFolderId(folderUrl);
    if (!folderId) {
      setError("Некорректная ссылка на папку Google Drive.");
      return;
    }

    setStatus(AppStatus.LOADING);
    setError(null);
    setFiles([]);

    try {
      setLoadingStep('Поиск файлов в облаке...');
      const cloudFiles = await fetchFolderFiles(folderId);
      
      if (cloudFiles.length === 0) {
        throw new Error("Не удалось получить файлы. Проверьте настройки доступа папки или используйте локальную загрузку.");
      }

      setFiles(cloudFiles);
      // Автоматически запускаем инференс после успешного получения файлов из облака
      await runInference(cloudFiles);
    } catch (err: any) {
      setError(err.message);
      setStatus(AppStatus.ERROR);
    }
  };

  const handleManualUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList) return;

    setStatus(AppStatus.LOADING);
    setLoadingStep('Обработка локальных файлов...');
    
    try {
      const loadedFiles: FileData[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(file);
        });
        loadedFiles.push({
          name: file.name,
          data: base64,
          mimeType: file.type || 'application/octet-stream',
          size: file.size
        });
      }
      const updatedFiles = [...files, ...loadedFiles];
      setFiles(updatedFiles);
      setStatus(AppStatus.IDLE);
      setError(null);
      // Не запускаем инференс сразу, чтобы пользователь мог добавить еще файлов
    } catch (err) {
      setError("Не удалось прочитать локальные файлы.");
      setStatus(AppStatus.ERROR);
    } finally {
      setLoadingStep('');
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0f1c] p-4 md:p-8 flex flex-col items-center max-w-7xl mx-auto font-sans text-slate-200">
      <header className="w-full mb-12 text-center">
        <div className="inline-block px-4 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] font-bold mb-4 uppercase tracking-[0.2em]">
          Gemini 3 Pro Multimodal Analysis
        </div>
        <h1 className="text-5xl md:text-7xl font-black mb-4 tracking-tighter text-white">
          Folder<span className="text-blue-500">Mind</span>
        </h1>
        <p className="text-slate-500 max-w-xl mx-auto text-base">Интеллектуальный суммаризатор папок: распознавание текста (OCR) из PDF и изображений.</p>
      </header>

      <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-10">
        {/* Левая панель: Ввод */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-slate-900/50 p-8 rounded-[2rem] border border-white/5 backdrop-blur-3xl shadow-2xl">
            <div className="mb-8">
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Ссылка на папку</label>
              <input
                type="text"
                value={folderUrl}
                onChange={(e) => setFolderUrl(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded-xl px-5 py-4 text-sm focus:ring-2 focus:ring-blue-500/50 outline-none transition-all text-white"
                placeholder="https://drive.google.com/..."
              />
            </div>

            <div className="grid grid-cols-1 gap-4">
              <button
                onClick={handleAutoScan}
                disabled={status === AppStatus.LOADING}
                className={`py-5 rounded-xl font-black text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-3 ${
                  status === AppStatus.LOADING
                    ? 'bg-slate-800 text-slate-500'
                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20'
                }`}
              >
                <i className={`fas ${status === AppStatus.LOADING ? 'fa-circle-notch fa-spin' : 'fa-cloud-download-alt'}`}></i>
                Сканировать облако
              </button>

              <div className="relative py-2 flex items-center justify-center">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-white/5"></div></div>
                <span className="relative bg-[#111827] px-4 text-[10px] text-slate-600 font-bold uppercase">или</span>
              </div>

              <div className="relative group">
                <input
                  type="file"
                  multiple
                  onChange={handleManualUpload}
                  className="absolute inset-0 opacity-0 cursor-pointer z-10"
                />
                <div className="w-full py-4 rounded-xl border border-dashed border-white/10 bg-white/5 hover:bg-white/10 text-slate-400 text-xs font-bold transition-all flex items-center justify-center gap-2">
                  <i className="fas fa-file-upload"></i>
                  Загрузить файлы вручную
                </div>
              </div>

              {files.length > 0 && status !== AppStatus.LOADING && (
                <button
                  onClick={() => runInference(files)}
                  className="w-full mt-4 py-5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-black text-xs uppercase tracking-widest hover:from-emerald-500 hover:to-teal-500 shadow-xl animate-bounce-subtle"
                >
                  <i className="fas fa-brain mr-2"></i>
                  Запустить анализ ({files.length} шт)
                </button>
              )}
            </div>

            {files.length > 0 && (
              <div className="mt-8 pt-6 border-t border-white/5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Список файлов</h3>
                  <button onClick={() => setFiles([])} className="text-[10px] text-red-500 font-bold hover:underline">Удалить все</button>
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scroll">
                  {files.map((f, i) => (
                    <div key={i} className="flex items-center gap-3 bg-white/5 p-3 rounded-lg border border-white/5">
                      <i className={`fas ${f.mimeType.includes('pdf') ? 'fa-file-pdf text-red-400' : 'fa-file-image text-blue-400'} text-xs`}></i>
                      <span className="text-[11px] truncate font-medium">{f.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Правая панель: Результаты */}
        <div className="lg:col-span-7">
          <div className="bg-slate-900/30 p-10 rounded-[2.5rem] border border-white/5 min-h-[600px] flex flex-col relative shadow-inner overflow-hidden">
            <h2 className="text-2xl font-black mb-8 flex items-center gap-3">
              <span className="w-2 h-8 bg-blue-500 rounded-full"></span>
              Аналитический отчет
            </h2>

            {status === AppStatus.IDLE && files.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center text-center opacity-40">
                <i className="fas fa-wand-magic-sparkles text-5xl mb-6"></i>
                <p className="max-w-xs text-sm">Добавьте файлы или укажите ссылку на папку, чтобы начать инференс.</p>
              </div>
            )}

            {status === AppStatus.LOADING && (
              <div className="flex-1 flex flex-col items-center justify-center">
                <div className="w-16 h-16 border-2 border-blue-500/20 border-t-blue-500 rounded-full animate-spin mb-6"></div>
                <p className="text-blue-400 font-black text-xs uppercase tracking-widest mb-2">Инференс в процессе</p>
                <p className="text-slate-500 text-xs">{loadingStep}</p>
              </div>
            )}

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 p-6 rounded-2xl text-red-400 text-sm">
                <div className="flex items-center gap-3 mb-2 font-bold uppercase text-xs">
                  <i className="fas fa-exclamation-circle"></i> Ошибка
                </div>
                {error}
              </div>
            )}

            {status === AppStatus.SUCCESS && summary && (
              <div className="space-y-8 animate-in fade-in duration-1000">
                <div className="bg-white/5 p-8 rounded-3xl border border-white/5">
                  <label className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-4 block">Общее саммари</label>
                  <p className="text-lg leading-relaxed font-medium text-slate-200">{summary.summary}</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-slate-800/30 p-6 rounded-2xl border border-white/5">
                    <label className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-4 block">Ключевые выводы</label>
                    <ul className="space-y-3">
                      {summary.keyPoints.map((p, i) => (
                        <li key={i} className="text-sm flex items-start gap-3 text-slate-300">
                          <i className="fas fa-check text-indigo-500 mt-1 text-[10px]"></i> {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="bg-slate-800/30 p-6 rounded-2xl border border-white/5">
                    <label className="text-[10px] font-black text-emerald-400 uppercase tracking-widest mb-4 block">Обнаруженные темы</label>
                    <div className="flex flex-wrap gap-2">
                      {summary.mainTopics.map((t, i) => (
                        <span key={i} className="px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-[10px] font-bold text-emerald-400">#{t}</span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="pt-6 border-t border-white/5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center text-blue-500 text-xs">
                      <i className="fas fa-info"></i>
                    </div>
                    <div>
                      <p className="text-[9px] text-slate-500 uppercase font-black">Характер данных</p>
                      <p className="text-xs font-bold">{summary.sentiment}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => navigator.clipboard.writeText(summary.summary)}
                    className="text-xs font-bold text-slate-500 hover:text-white transition-colors"
                  >
                    <i className="fas fa-copy mr-1"></i> Копировать текст
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes bounce-subtle {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-5px); }
        }
        .animate-bounce-subtle {
          animation: bounce-subtle 2s infinite ease-in-out;
        }
      `}</style>
    </div>
  );
};

export default App;
