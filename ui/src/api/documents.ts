import { api } from "./client";

export interface DocumentEntry {
  path: string;
  name: string;
  size: number;
  modified: string;
  isDirectory: boolean;
}

export interface DocumentListResponse {
  documents: DocumentEntry[];
  rootDir: string;
}

export interface DocumentContentResponse {
  path: string;
  content: string;
  size: number;
  modified: string;
}

export const documentsApi = {
  list(projectId: string) {
    return api.get<DocumentListResponse>(`/projects/${projectId}/documents`);
  },
  getContent(projectId: string, filePath: string) {
    return api.get<DocumentContentResponse>(
      `/projects/${projectId}/document?path=${encodeURIComponent(filePath)}`,
    );
  },
};
