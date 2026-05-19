import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runAdapterExecutionTargetProcess,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
} = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    runAdapterExecutionTargetProcess,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
  };
});

import { execute } from "./execute.js";

describe("codex execution billing attribution", () => {
  const cleanupDirs: string[] = [];
  const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;

  afterEach(async () => {
    vi.clearAllMocks();
    if (originalOpenRouterApiKey == null) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("attributes direct OpenAI API runs to OpenAI despite an ambient host OpenRouter key", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-host-ambient";
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-billing-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    const result = await execute({
      runId: "run-direct-openai",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
          OPENAI_API_KEY: "sk-direct-openai",
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(result.biller).toBe("openai");
    expect(result.billingType).toBe("api");
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(call?.[4].env.OPENAI_API_KEY).toBe("sk-direct-openai");
    expect(call?.[4].env.OPENROUTER_API_KEY).toBeUndefined();
  });
});
