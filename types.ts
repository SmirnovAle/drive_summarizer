
export interface SummaryResult {
  summary: string;
  keyPoints: string[];
  mainTopics: string[];
  sentiment: string;
}

export interface FileData {
  name: string;
  data: string; // base64 string
  mimeType: string;
  size: number;
}

export enum AppStatus {
  IDLE = 'IDLE',
  LOADING = 'LOADING',
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR'
}
