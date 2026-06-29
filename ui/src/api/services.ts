import { api } from "./client";

export interface ServiceStatus {
  key: string;
  name: string;
  description: string;
  url: string;
  status: "up" | "down";
  latencyMs: number | null;
  detail: unknown;
  error: string | null;
}

export interface ServicesStatusResponse {
  services: ServiceStatus[];
  checkedAt: string;
}

export const servicesApi = {
  status() {
    return api.get<ServicesStatusResponse>(`/services/status`);
  },
};
