import type { ExternalObjectMentionGroup, ExternalObjectSummary } from "@paperclipai/shared";
import { api } from "./client";

export const externalObjectsApi = {
  listForIssue: (issueId: string) =>
    api.get<ExternalObjectMentionGroup[]>(`/issues/${issueId}/external-objects`),
  getIssueSummary: (issueId: string) =>
    api.get<ExternalObjectSummary>(`/issues/${issueId}/external-object-summary`),
  refreshIssueObjects: (issueId: string, data?: { objectIds?: string[] }) =>
    api.post<{ refreshed: unknown[] }>(`/issues/${issueId}/external-objects/refresh`, data ?? {}),
  getProjectSummary: (projectId: string) =>
    api.get<ExternalObjectSummary>(`/projects/${projectId}/external-object-summary`),
};
