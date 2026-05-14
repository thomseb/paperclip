import { describe, expect, it } from "vitest";
import {
  buildFilePatch,
  buildFilePatches,
  diffSummary,
  nextExpandedFileSet,
  statusLabel,
  toFileViewModels,
} from "../src/diff-model.js";
import { changedFile, diffResponse } from "./fixtures.js";

describe("workspace diff UI model", () => {
  it("summarizes changed files and line counts", () => {
    const diff = diffResponse();

    expect(diffSummary(diff)).toMatchObject({
      changedLabel: "1 file",
      lineLabel: "+1 / -1",
      warningCount: 0,
      truncated: false,
    });
    expect(toFileViewModels(diff)[0]).toMatchObject({
      path: "src/app.ts",
      status: "modified",
      patchKinds: ["unstaged"],
    });
  });

  it("represents empty workspace diffs", () => {
    const diff = diffResponse({ files: [] });

    expect(toFileViewModels(diff)).toEqual([]);
    expect(diffSummary(diff).changedLabel).toBe("0 files");
  });

  it("surfaces truncation and file warnings", () => {
    const file = changedFile({
      truncated: true,
      warnings: [{ code: "patch_truncated", message: "Patch was truncated.", path: "src/app.ts" }],
      patches: [],
    });
    const diff = diffResponse({ files: [file], truncated: true });

    expect(buildFilePatch(file)).toBeNull();
    expect(diffSummary(diff)).toMatchObject({
      warningCount: 1,
      truncated: true,
    });
  });

  it("keeps staged and unstaged patches renderable as separate single-file diffs", () => {
    const stagedPatch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n");
    const unstagedPatch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 2222222..3333333 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -3 +3 @@",
      "-export const label = 'old';",
      "+export const label = 'new';",
      "",
    ].join("\n");
    const file = changedFile({
      staged: true,
      unstaged: true,
      patches: [
        {
          kind: "staged",
          patch: stagedPatch,
          additions: 1,
          deletions: 1,
          binary: false,
          oversized: false,
          truncated: false,
          warnings: [],
        },
        {
          kind: "unstaged",
          patch: unstagedPatch,
          additions: 1,
          deletions: 1,
          binary: false,
          oversized: false,
          truncated: false,
          warnings: [],
        },
      ],
    });

    const patches = buildFilePatches(file);
    const viewModel = toFileViewModels(diffResponse({ files: [file] }))[0];

    expect(buildFilePatch(file)).toBe(stagedPatch.trimEnd());
    expect(patches.map((patch) => patch.kind)).toEqual(["staged", "unstaged"]);
    expect(patches.map((patch) => patch.patch?.match(/^diff --git/gm)?.length ?? 0)).toEqual([1, 1]);
    expect(viewModel?.patches).toHaveLength(2);
    expect(viewModel?.patchKinds).toEqual(["staged", "unstaged"]);
  });

  it("toggles expanded file state without mutating the current set", () => {
    const current = new Set(["a.ts"]);
    const collapsed = nextExpandedFileSet(current, "a.ts");
    const expanded = nextExpandedFileSet(current, "b.ts");

    expect(current.has("a.ts")).toBe(true);
    expect(collapsed.has("a.ts")).toBe(false);
    expect(expanded.has("b.ts")).toBe(true);
  });

  it("labels file statuses for the sidebar", () => {
    expect(statusLabel("untracked")).toBe("Untracked");
    expect(statusLabel("type_changed")).toBe("Type changed");
  });
});
