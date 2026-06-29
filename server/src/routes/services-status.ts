import { Router } from "express";

/**
 * Reports liveness of the companion services that make up the AI agent
 * company stack: the LangGraph workflow engine, the LlamaIndex knowledge
 * layer, and the py-opencode messaging ecosystem.
 *
 * Each service exposes a GET /health endpoint. This route fans out to all
 * of them with a short timeout and returns a normalized status array the
 * UI can poll.
 */

interface ServiceTarget {
  key: string;
  name: string;
  description: string;
  baseUrl: string;
  healthPath: string;
}

interface ServiceStatus {
  key: string;
  name: string;
  description: string;
  url: string;
  status: "up" | "down";
  latencyMs: number | null;
  detail: unknown;
  error: string | null;
}

function buildTargets(): ServiceTarget[] {
  const workflowPort = process.env.WORKFLOW_ENGINE_PORT ?? "8100";
  const knowledgePort = process.env.KNOWLEDGE_LAYER_PORT ?? "8200";
  const opencodeUrl = process.env.OPENCODE_URL ?? "http://localhost:8000";

  return [
    {
      key: "workflow_engine",
      name: "Workflow Engine",
      description: "LangGraph customer-escalation graph, checkpointing, human-in-the-loop",
      baseUrl: process.env.WORKFLOW_ENGINE_URL ?? `http://localhost:${workflowPort}`,
      healthPath: "/health",
    },
    {
      key: "knowledge_layer",
      name: "Knowledge Layer",
      description: "LlamaIndex vector search, Gmail/Notion/Slack connectors, PARA memory",
      baseUrl: process.env.KNOWLEDGE_LAYER_URL ?? `http://localhost:${knowledgePort}`,
      healthPath: "/health",
    },
    {
      key: "opencode",
      name: "py-opencode",
      description: "Multi-platform messaging ecosystem (WhatsApp, Teams, Outlook)",
      baseUrl: opencodeUrl,
      healthPath: "/health",
    },
  ];
}

async function probe(target: ServiceTarget): Promise<ServiceStatus> {
  const url = `${target.baseUrl.replace(/\/$/, "")}${target.healthPath}`;
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    const latencyMs = Date.now() - start;
    let detail: unknown = null;
    try {
      detail = await resp.json();
    } catch {
      detail = await resp.text().catch(() => null);
    }
    return {
      key: target.key,
      name: target.name,
      description: target.description,
      url,
      status: resp.ok ? "up" : "down",
      latencyMs,
      detail,
      error: resp.ok ? null : `HTTP ${resp.status}`,
    };
  } catch (err) {
    return {
      key: target.key,
      name: target.name,
      description: target.description,
      url,
      status: "down",
      latencyMs: null,
      detail: null,
      error: err instanceof Error ? err.message : "Unreachable",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function servicesStatusRoutes() {
  const router = Router();

  router.get("/services/status", async (_req, res, next) => {
    try {
      const targets = buildTargets();
      const services = await Promise.all(targets.map(probe));
      res.json({
        services,
        checkedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
