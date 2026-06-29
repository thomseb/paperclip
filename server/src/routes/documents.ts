import { Router, type Request } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { projectService } from "../services/index.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { assertCompanyAccess } from "./authz.js";

interface DocumentEntry {
  path: string;
  name: string;
  size: number;
  modified: string;
  isDirectory: boolean;
}

async function walkDirectory(
  rootDir: string,
  currentDir: string,
  entries: DocumentEntry[],
): Promise<void> {
  let dirEntries;
  try {
    dirEntries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of dirEntries) {
    // Skip hidden files/dirs and skills directory
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "skills" && currentDir === rootDir) continue;

    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath).split(path.sep).join("/");

    if (entry.isDirectory()) {
      entries.push({
        path: relativePath,
        name: entry.name,
        size: 0,
        modified: "",
        isDirectory: true,
      });
      await walkDirectory(rootDir, fullPath, entries);
    } else if (
      entry.name.endsWith(".md") ||
      entry.name.endsWith(".txt") ||
      entry.name.endsWith(".yaml") ||
      entry.name.endsWith(".yml") ||
      entry.name.endsWith(".json")
    ) {
      try {
        const stat = await fs.stat(fullPath);
        entries.push({
          path: relativePath,
          name: entry.name,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          isDirectory: false,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }
}

function sanitizePath(filePath: string): string | null {
  const normalized = path.normalize(filePath).split(path.sep).join("/");
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

export function documentRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);

  async function resolveProjectWorkspaceDir(
    req: Request,
    projectId: string,
  ): Promise<string | null> {
    const project = await svc.getById(projectId);
    if (!project) return null;
    assertCompanyAccess(req, project.companyId);

    return resolveManagedProjectWorkspaceDir({
      companyId: project.companyId,
      projectId: project.id,
    });
  }

  // List all documents in a project workspace
  router.get("/projects/:id/documents", async (req, res, next) => {
    try {
      const projectId = req.params.id;
      const workspaceDir = await resolveProjectWorkspaceDir(req, projectId);
      if (!workspaceDir) {
        return res.status(404).json({ error: "Project not found" });
      }

      const entries: DocumentEntry[] = [];
      await walkDirectory(workspaceDir, workspaceDir, entries);

      // Sort: directories first, then files, alphabetically
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.path.localeCompare(b.path);
      });

      return res.json({ documents: entries, rootDir: workspaceDir });
    } catch (err) {
      next(err);
    }
  });

  // Get content of a specific document (file path passed as ?path= query param)
  router.get("/projects/:id/document", async (req, res, next) => {
    try {
      const projectId = req.params.id;
      const filePath = typeof req.query.path === "string" ? req.query.path : "";

      const sanitized = sanitizePath(filePath);
      if (!sanitized) {
        return res.status(400).json({ error: "Invalid file path" });
      }

      const workspaceDir = await resolveProjectWorkspaceDir(req, projectId);
      if (!workspaceDir) {
        return res.status(404).json({ error: "Project not found" });
      }

      const fullPath = path.join(workspaceDir, sanitized);

      // Verify the resolved path is still within workspace
      const resolved = path.resolve(fullPath);
      const resolvedRoot = path.resolve(workspaceDir);
      if (!resolved.startsWith(resolvedRoot)) {
        return res.status(400).json({ error: "Path traversal denied" });
      }

      try {
        const content = await fs.readFile(fullPath, "utf8");
        const stat = await fs.stat(fullPath);
        return res.json({
          path: sanitized,
          content,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      } catch {
        return res.status(404).json({ error: "File not found" });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
