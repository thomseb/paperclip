import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  externalObjectMentions,
  externalObjects,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createExternalObjectDetectorRegistry,
  createExternalObjectResolverRegistry,
  externalObjectService,
  type ExternalObjectResolver,
} from "../services/external-objects.js";
import { canonicalizeExternalObjectUrl } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres external object tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("external object registries", () => {
  it("lets provider detectors claim urls before the generic fallback", async () => {
    const canonical = canonicalizeExternalObjectUrl("https://github.com/acme/app/pull/42");
    if (!canonical) throw new Error("expected canonical url");
    const registry = createExternalObjectDetectorRegistry([
      {
        key: "github",
        detect: ({ urls }) =>
          urls.map((url) => ({
            canonical: url,
            detectorKey: "github",
            providerKey: "github",
            objectType: "pull_request",
            externalId: "acme/app#42",
            confidence: "exact",
          })),
      },
    ]);

    const detections = await registry.detect({
      companyId: "company-1",
      urls: [canonical],
      sourceContext: {
        companyId: "company-1",
        sourceIssueId: "issue-1",
        sourceKind: "description",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
      },
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      providerKey: "github",
      objectType: "pull_request",
      externalId: "acme/app#42",
    });
  });

  it("falls back to generic url objects when no provider detector claims a url", async () => {
    const canonical = canonicalizeExternalObjectUrl("https://example.com/path?token=secret#frag");
    if (!canonical) throw new Error("expected canonical url");
    const registry = createExternalObjectDetectorRegistry([]);

    const detections = await registry.detect({
      companyId: "company-1",
      urls: [canonical],
      sourceContext: {
        companyId: "company-1",
        sourceIssueId: "issue-1",
        sourceKind: "description",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
      },
    });

    expect(detections[0]).toMatchObject({
      providerKey: "url",
      objectType: "link",
      externalId: canonical.canonicalIdentityHash,
      displayTitle: "https://example.com/path",
    });
  });

  it("matches resolvers by provider and optional object type", () => {
    const fallbackResolver: ExternalObjectResolver = {
      providerKey: "github",
      resolve: async () => ({
        ok: true,
        snapshot: { statusCategory: "unknown", statusTone: "neutral" },
      }),
    };
    const pullRequestResolver: ExternalObjectResolver = {
      providerKey: "github",
      objectType: "pull_request",
      resolve: async () => ({
        ok: true,
        snapshot: { statusCategory: "open", statusTone: "info" },
      }),
    };
    const registry = createExternalObjectResolverRegistry([pullRequestResolver, fallbackResolver]);

    expect(registry.find({ providerKey: "github", objectType: "pull_request" })).toBe(pullRequestResolver);
    expect(registry.find({ providerKey: "github", objectType: "issue" })).toBe(fallbackResolver);
    expect(registry.find({ providerKey: "linear", objectType: "issue" })).toBeNull();
  });
});

describeEmbeddedPostgres("externalObjectService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-external-objects-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createIssue(companyId = randomUUID()) {
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-2265",
      title: "External refs",
      description: "Track https://github.com/acme/app/pull/42?token=secret#discussion twice https://github.com/acme/app/pull/42.",
      status: "todo",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  it("syncs sanitized, deduped mentions without storing secret-bearing urls", async () => {
    const { companyId, issueId } = await createIssue();
    const svc = externalObjectService(db);

    await svc.syncIssue(issueId);

    const [objectRows, mentionRows] = await Promise.all([
      db.select().from(externalObjects),
      db.select().from(externalObjectMentions),
    ]);
    expect(objectRows).toHaveLength(1);
    expect(objectRows[0]).toMatchObject({
      companyId,
      providerKey: "url",
      objectType: "link",
      sanitizedCanonicalUrl: "https://github.com/acme/app/pull/42",
      liveness: "unknown",
      statusCategory: "unknown",
    });
    expect(JSON.stringify(objectRows[0])).not.toContain("secret");
    expect(mentionRows).toHaveLength(1);
    expect(mentionRows[0]).toMatchObject({
      companyId,
      sourceIssueId: issueId,
      sourceKind: "description",
      sanitizedDisplayUrl: "https://github.com/acme/app/pull/42",
      matchedTextRedacted: "https://github.com/acme/app/pull/42",
    });
  });

  it("preserves last-known status when resolver reports auth and unreachable failures", async () => {
    const { companyId, issueId } = await createIssue();
    const resolver: ExternalObjectResolver = {
      providerKey: "url",
      objectType: "link",
      resolve: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          snapshot: {
            statusCategory: "open",
            statusTone: "info",
            statusKey: "open",
            statusLabel: "Open",
            ttlSeconds: 1,
          },
        })
        .mockResolvedValueOnce({
          ok: false,
          liveness: "auth_required",
          errorCode: "auth_required",
          errorMessage: "token failed for https://github.com/acme/app/pull/42?token=secret",
          retryAfterSeconds: 60,
        })
        .mockResolvedValueOnce({
          ok: false,
          liveness: "unreachable",
          errorCode: "network",
          errorMessage: "GET https://github.com/acme/app/pull/42 failed",
          retryAfterSeconds: 60,
        }),
    };
    const svc = externalObjectService(db, { resolvers: [resolver] });
    await svc.syncIssue(issueId);
    const object = await db.select().from(externalObjects).then((rows) => rows[0]!);

    await svc.refreshObject(object.id, { companyId, force: true });
    await svc.refreshObject(object.id, { companyId, force: true });
    await svc.refreshObject(object.id, { companyId, force: true });

    const updated = await db.select().from(externalObjects).then((rows) => rows[0]!);
    expect(updated.statusCategory).toBe("open");
    expect(updated.statusLabel).toBe("Open");
    expect(updated.liveness).toBe("unreachable");
    expect(updated.lastErrorMessage).toContain("[redacted-url]");
    expect(updated.lastErrorMessage).not.toContain("secret");
  });

  it("keeps external object identities company-scoped for duplicate urls", async () => {
    const first = await createIssue();
    const second = await createIssue();
    const svc = externalObjectService(db);

    await svc.syncIssue(first.issueId);
    await svc.syncIssue(second.issueId);

    const objectRows = await db.select().from(externalObjects);
    expect(objectRows).toHaveLength(2);
    expect(new Set(objectRows.map((row) => row.companyId))).toEqual(new Set([first.companyId, second.companyId]));
    expect(new Set(objectRows.map((row) => row.canonicalIdentityHash))).toHaveSize(1);
  });
});
