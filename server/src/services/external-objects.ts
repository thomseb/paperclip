import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, externalObjectMentions, externalObjects, issueComments, issueDocuments, issues } from "@paperclipai/db";
import {
  extractExternalObjectCanonicalUrls,
  formatExternalObjectMentionSourceLabel,
  type ExternalObjectCanonicalUrl,
  type ExternalObjectLivenessState,
  type ExternalObjectMentionConfidence,
  type ExternalObjectMentionSourceKind,
  type ExternalObjectStatusCategory,
  type ExternalObjectStatusTone,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { publishLiveEvent } from "./live-events.js";

export interface ExternalObjectSourceContext {
  companyId: string;
  sourceIssueId: string;
  sourceKind: ExternalObjectMentionSourceKind;
  sourceRecordId: string | null;
  documentKey: string | null;
  propertyKey: string | null;
}

export interface ExternalObjectDetection {
  canonical: ExternalObjectCanonicalUrl;
  detectorKey: string;
  providerKey: string;
  objectType: string;
  externalId: string;
  displayTitle?: string | null;
  confidence?: ExternalObjectMentionConfidence;
  pluginId?: string | null;
}

export interface ExternalObjectDetector {
  key: string;
  detect(input: {
    companyId: string;
    urls: ExternalObjectCanonicalUrl[];
    sourceContext: ExternalObjectSourceContext;
  }): Promise<ExternalObjectDetection[]> | ExternalObjectDetection[];
}

export interface ExternalObjectResolverSnapshot {
  displayTitle?: string | null;
  statusKey?: string | null;
  statusLabel?: string | null;
  statusCategory: ExternalObjectStatusCategory;
  statusTone: ExternalObjectStatusTone;
  isTerminal?: boolean;
  data?: Record<string, unknown>;
  remoteVersion?: string | null;
  etag?: string | null;
  ttlSeconds?: number;
}

export type ExternalObjectResolveResult =
  | { ok: true; snapshot: ExternalObjectResolverSnapshot }
  | {
      ok: false;
      liveness: Extract<ExternalObjectLivenessState, "auth_required" | "unreachable">;
      errorCode: string;
      errorMessage?: string | null;
      retryAfterSeconds?: number;
    };

export interface ExternalObjectResolver {
  providerKey: string;
  objectType?: string;
  resolve(input: {
    companyId: string;
    object: ExternalObjectRecord;
  }): Promise<ExternalObjectResolveResult>;
}

type ExternalObjectRecord = typeof externalObjects.$inferSelect;
type ExternalObjectMentionRecord = typeof externalObjectMentions.$inferSelect;

const DEFAULT_REFRESH_TTL_SECONDS = 300;
const DEFAULT_RETRY_AFTER_SECONDS = 300;

function sourceWhere(input: ExternalObjectSourceContext) {
  const conditions = [
    eq(externalObjectMentions.companyId, input.companyId),
    eq(externalObjectMentions.sourceIssueId, input.sourceIssueId),
    eq(externalObjectMentions.sourceKind, input.sourceKind),
  ];
  if (input.sourceRecordId) {
    conditions.push(eq(externalObjectMentions.sourceRecordId, input.sourceRecordId));
  } else {
    conditions.push(isNull(externalObjectMentions.sourceRecordId));
  }
  if (input.documentKey) {
    conditions.push(eq(externalObjectMentions.documentKey, input.documentKey));
  } else {
    conditions.push(isNull(externalObjectMentions.documentKey));
  }
  if (input.propertyKey) {
    conditions.push(eq(externalObjectMentions.propertyKey, input.propertyKey));
  } else {
    conditions.push(isNull(externalObjectMentions.propertyKey));
  }
  return and(...conditions);
}

function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + Math.max(1, seconds) * 1000);
}

function visibleLiveness(object: ExternalObjectRecord, now = new Date()): ExternalObjectLivenessState {
  if (object.liveness === "fresh" && object.nextRefreshAt && object.nextRefreshAt <= now) {
    return "stale";
  }
  return object.liveness;
}

function objectChanged(before: ExternalObjectRecord, after: ExternalObjectRecord) {
  return (
    before.statusKey !== after.statusKey ||
    before.statusLabel !== after.statusLabel ||
    before.statusCategory !== after.statusCategory ||
    before.statusTone !== after.statusTone ||
    before.isTerminal !== after.isTerminal
  );
}

function sanitizeErrorMessage(message: string | null | undefined) {
  if (!message) return null;
  return message
    .replace(/https?:\/\/[^\s<>()]+/gi, "[redacted-url]")
    .replace(/\b(?:token|key|secret|authorization|bearer)=\S+/gi, "$1=[redacted]");
}

function genericUrlDetector(): ExternalObjectDetector {
  return {
    key: "generic-url",
    detect({ urls }) {
      return urls.map((canonical) => ({
        canonical,
        detectorKey: "generic-url",
        providerKey: "url",
        objectType: "link",
        externalId: canonical.canonicalIdentityHash,
        displayTitle: canonical.sanitizedDisplayUrl,
        confidence: "possible",
      }));
    },
  };
}

export function createExternalObjectDetectorRegistry(detectors: ExternalObjectDetector[] = []) {
  const entries = [...detectors, genericUrlDetector()];

  async function detect(input: {
    companyId: string;
    urls: ExternalObjectCanonicalUrl[];
    sourceContext: ExternalObjectSourceContext;
  }) {
    const claimed = new Set<string>();
    const detections: ExternalObjectDetection[] = [];
    for (const detector of entries) {
      const remaining = input.urls.filter((url) => !claimed.has(url.canonicalIdentityHash));
      if (remaining.length === 0) break;
      try {
        const detected = await detector.detect({ ...input, urls: remaining });
        for (const detection of detected) {
          if (claimed.has(detection.canonical.canonicalIdentityHash)) continue;
          claimed.add(detection.canonical.canonicalIdentityHash);
          detections.push({ ...detection, detectorKey: detection.detectorKey || detector.key });
        }
      } catch (err) {
        logger.warn({ err, detectorKey: detector.key }, "external object detector failed");
      }
    }
    return detections;
  }

  return { detect };
}

export function createExternalObjectResolverRegistry(resolvers: ExternalObjectResolver[] = []) {
  function find(object: Pick<ExternalObjectRecord, "providerKey" | "objectType">) {
    return resolvers.find(
      (resolver) =>
        resolver.providerKey === object.providerKey &&
        (!resolver.objectType || resolver.objectType === object.objectType),
    ) ?? null;
  }
  return { find };
}

export function externalObjectService(
  db: Db,
  opts: {
    detectors?: ExternalObjectDetector[];
    resolvers?: ExternalObjectResolver[];
  } = {},
) {
  const detectorRegistry = createExternalObjectDetectorRegistry(opts.detectors ?? []);
  const resolverRegistry = createExternalObjectResolverRegistry(opts.resolvers ?? []);

  async function issueById(issueId: string, dbOrTx: any = db) {
    return dbOrTx
      .select({
        id: issues.id,
        companyId: issues.companyId,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows: Array<{ id: string; companyId: string; title: string; description: string | null }>) => rows[0] ?? null);
  }

  async function upsertObjectFromDetection(
    companyId: string,
    detection: ExternalObjectDetection,
    dbOrTx: any,
  ): Promise<ExternalObjectRecord> {
    const now = new Date();
    const canonical = detection.canonical;
    const values = {
      companyId,
      providerKey: detection.providerKey,
      pluginId: detection.pluginId ?? null,
      objectType: detection.objectType,
      externalId: detection.externalId,
      sanitizedCanonicalUrl: canonical.sanitizedCanonicalUrl,
      canonicalIdentityHash: canonical.canonicalIdentityHash,
      displayTitle: detection.displayTitle ?? canonical.sanitizedDisplayUrl,
      updatedAt: now,
    };
    const inserted = await dbOrTx
      .insert(externalObjects)
      .values(values)
      .onConflictDoUpdate({
        target: [
          externalObjects.companyId,
          externalObjects.providerKey,
          externalObjects.objectType,
          externalObjects.externalId,
        ],
        set: {
          sanitizedCanonicalUrl: values.sanitizedCanonicalUrl,
          canonicalIdentityHash: values.canonicalIdentityHash,
          displayTitle: values.displayTitle,
          updatedAt: now,
        },
      })
      .returning();
    return inserted[0]!;
  }

  async function replaceSourceMentions(
    input: ExternalObjectSourceContext & { text: string | null | undefined },
    dbOrTx: any = db,
  ) {
    const urls = extractExternalObjectCanonicalUrls(input.text ?? "");
    await dbOrTx.delete(externalObjectMentions).where(sourceWhere(input));
    if (urls.length === 0) return;

    const detections = await detectorRegistry.detect({
      companyId: input.companyId,
      urls,
      sourceContext: input,
    });
    if (detections.length === 0) return;

    const seen = new Set<string>();
    const values: Array<typeof externalObjectMentions.$inferInsert> = [];
    for (const detection of detections) {
      const canonicalHash = detection.canonical.canonicalIdentityHash;
      const sourceKey = `${detection.providerKey}:${detection.objectType}:${canonicalHash}`;
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      const object = await upsertObjectFromDetection(input.companyId, detection, dbOrTx);
      values.push({
        companyId: input.companyId,
        sourceIssueId: input.sourceIssueId,
        sourceKind: input.sourceKind,
        sourceRecordId: input.sourceRecordId,
        documentKey: input.documentKey,
        propertyKey: input.propertyKey,
        matchedTextRedacted: detection.canonical.redactedMatchedText,
        sanitizedDisplayUrl: detection.canonical.sanitizedDisplayUrl,
        canonicalIdentityHash: canonicalHash,
        canonicalIdentity: detection.canonical.canonicalIdentity as unknown as Record<string, unknown>,
        objectId: object.id,
        providerKey: detection.providerKey,
        detectorKey: detection.detectorKey,
        objectType: detection.objectType,
        confidence: detection.confidence ?? "exact",
        createdByPluginId: detection.pluginId ?? null,
      });
    }
    if (values.length > 0) {
      await dbOrTx.insert(externalObjectMentions).values(values);
    }
  }

  async function syncIssue(issueId: string, dbOrTx: any = db) {
    const runSync = async (tx: any) => {
      const issue = await issueById(issueId, tx);
      if (!issue) throw notFound("Issue not found");
      await replaceSourceMentions({
        companyId: issue.companyId,
        sourceIssueId: issue.id,
        sourceKind: "title",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
        text: issue.title,
      }, tx);
      await replaceSourceMentions({
        companyId: issue.companyId,
        sourceIssueId: issue.id,
        sourceKind: "description",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
        text: issue.description,
      }, tx);
    };
    return dbOrTx === db ? db.transaction(runSync) : runSync(dbOrTx);
  }

  async function syncComment(commentId: string, dbOrTx: any = db) {
    const comment = await dbOrTx
      .select({
        id: issueComments.id,
        companyId: issueComments.companyId,
        issueId: issueComments.issueId,
        body: issueComments.body,
      })
      .from(issueComments)
      .where(eq(issueComments.id, commentId))
      .then((rows: Array<{ id: string; companyId: string; issueId: string; body: string }>) => rows[0] ?? null);
    if (!comment) throw notFound("Issue comment not found");
    await replaceSourceMentions({
      companyId: comment.companyId,
      sourceIssueId: comment.issueId,
      sourceKind: "comment",
      sourceRecordId: comment.id,
      documentKey: null,
      propertyKey: null,
      text: comment.body,
    }, dbOrTx);
  }

  async function syncDocument(documentId: string, dbOrTx: any = db) {
    const document = await dbOrTx
      .select({
        documentId: documents.id,
        companyId: documents.companyId,
        issueId: issueDocuments.issueId,
        key: issueDocuments.key,
        body: documents.latestBody,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(eq(documents.id, documentId))
      .then((rows: Array<{ documentId: string; companyId: string; issueId: string; key: string; body: string }>) => rows[0] ?? null);
    if (!document) {
      await dbOrTx
        .delete(externalObjectMentions)
        .where(and(eq(externalObjectMentions.sourceKind, "document"), eq(externalObjectMentions.sourceRecordId, documentId)));
      return;
    }
    await replaceSourceMentions({
      companyId: document.companyId,
      sourceIssueId: document.issueId,
      sourceKind: "document",
      sourceRecordId: document.documentId,
      documentKey: document.key,
      propertyKey: null,
      text: document.body,
    }, dbOrTx);
  }

  async function safeSync(label: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      logger.warn({ err }, `external object ${label} sync failed`);
    }
  }

  async function syncIssueSafely(issueId: string) {
    await safeSync("issue", () => syncIssue(issueId));
  }

  async function syncCommentSafely(commentId: string) {
    await safeSync("comment", () => syncComment(commentId));
  }

  async function syncDocumentSafely(documentId: string) {
    await safeSync("document", () => syncDocument(documentId));
  }

  function toObjectPayload(object: ExternalObjectRecord, now = new Date()) {
    return {
      ...object,
      liveness: visibleLiveness(object, now),
    };
  }

  async function listForIssue(issueId: string) {
    const issue = await issueById(issueId);
    if (!issue) throw notFound("Issue not found");
    const rows = await db
      .select({
        mention: externalObjectMentions,
        object: externalObjects,
      })
      .from(externalObjectMentions)
      .leftJoin(externalObjects, eq(externalObjectMentions.objectId, externalObjects.id))
      .where(and(
        eq(externalObjectMentions.companyId, issue.companyId),
        eq(externalObjectMentions.sourceIssueId, issue.id),
      ))
      .orderBy(asc(externalObjectMentions.sourceKind), asc(externalObjectMentions.createdAt));
    const now = new Date();
    const grouped = new Map<string, {
      object: ReturnType<typeof toObjectPayload> | null;
      mentions: ExternalObjectMentionRecord[];
      mentionCount: number;
      sourceLabels: string[];
    }>();
    for (const row of rows) {
      const key = row.object?.id ?? `mention:${row.mention.id}`;
      const existing = grouped.get(key) ?? {
        object: row.object ? toObjectPayload(row.object, now) : null,
        mentions: [],
        mentionCount: 0,
        sourceLabels: [],
      };
      existing.mentions.push(row.mention);
      existing.mentionCount += 1;
      const label = formatExternalObjectMentionSourceLabel({
        sourceKind: row.mention.sourceKind,
        documentKey: row.mention.documentKey,
        propertyKey: row.mention.propertyKey,
      });
      if (!existing.sourceLabels.includes(label)) existing.sourceLabels.push(label);
      grouped.set(key, existing);
    }
    return [...grouped.values()];
  }

  function summarizeObjects(objects: Array<ReturnType<typeof toObjectPayload>>) {
    const byStatusCategory: Record<string, number> = {};
    const byLiveness: Record<string, number> = {};
    let highestSeverity: ExternalObjectStatusTone = "neutral";
    const severityRank: Record<ExternalObjectStatusTone, number> = {
      neutral: 0,
      muted: 0,
      success: 1,
      info: 2,
      warning: 3,
      danger: 4,
    };
    for (const object of objects) {
      byStatusCategory[object.statusCategory] = (byStatusCategory[object.statusCategory] ?? 0) + 1;
      byLiveness[object.liveness] = (byLiveness[object.liveness] ?? 0) + 1;
      const livenessTone = object.liveness === "auth_required" || object.liveness === "unreachable"
        ? "danger"
        : object.liveness === "stale"
        ? "warning"
        : object.statusTone;
      if (severityRank[livenessTone] > severityRank[highestSeverity]) highestSeverity = livenessTone;
    }
    return {
      total: objects.length,
      byStatusCategory,
      byLiveness,
      highestSeverity,
      staleCount: byLiveness.stale ?? 0,
      authRequiredCount: byLiveness.auth_required ?? 0,
      unreachableCount: byLiveness.unreachable ?? 0,
    };
  }

  async function getIssueSummary(issueId: string) {
    const groups = await listForIssue(issueId);
    const objects = groups.flatMap((group) => (group.object ? [group.object] : []));
    return {
      ...summarizeObjects(objects),
      objects: objects.map((object) => ({
        id: object.id,
        providerKey: object.providerKey,
        objectType: object.objectType,
        displayTitle: object.displayTitle,
        statusCategory: object.statusCategory,
        statusTone: object.statusTone,
        liveness: object.liveness,
        isTerminal: object.isTerminal,
      })),
    };
  }

  async function getProjectSummary(projectId: string) {
    const projectIssues = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"])));
    if (projectIssues.length === 0) return { ...summarizeObjects([]), objects: [] };
    const companyIds = new Set(projectIssues.map((issue) => issue.companyId));
    if (companyIds.size !== 1) return { ...summarizeObjects([]), objects: [] };
    const issueIds = projectIssues.map((issue) => issue.id);
    const rows = await db
      .select({ object: externalObjects })
      .from(externalObjectMentions)
      .innerJoin(externalObjects, eq(externalObjectMentions.objectId, externalObjects.id))
      .where(and(
        eq(externalObjectMentions.companyId, projectIssues[0]!.companyId),
        inArray(externalObjectMentions.sourceIssueId, issueIds),
      ));
    const now = new Date();
    const objectsById = new Map<string, ReturnType<typeof toObjectPayload>>();
    for (const row of rows) objectsById.set(row.object.id, toObjectPayload(row.object, now));
    const objects = [...objectsById.values()];
    return {
      ...summarizeObjects(objects),
      objects: objects.slice(0, 25).map((object) => ({
        id: object.id,
        providerKey: object.providerKey,
        objectType: object.objectType,
        displayTitle: object.displayTitle,
        statusCategory: object.statusCategory,
        statusTone: object.statusTone,
        liveness: object.liveness,
        isTerminal: object.isTerminal,
      })),
    };
  }

  async function refreshObject(
    objectId: string,
    input: {
      companyId: string;
      actor?: Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId">;
      force?: boolean;
      now?: Date;
    },
  ) {
    const now = input.now ?? new Date();
    const object = await db
      .select()
      .from(externalObjects)
      .where(and(eq(externalObjects.id, objectId), eq(externalObjects.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!object) throw notFound("External object not found");
    if (!input.force && object.nextRefreshAt && object.nextRefreshAt > now) {
      return { object: toObjectPayload(object, now), refreshed: false, reason: "backoff" as const };
    }

    const resolver = resolverRegistry.find(object);
    if (!resolver) {
      const [updated] = await db
        .update(externalObjects)
        .set({
          liveness: visibleLiveness(object, now) === "fresh" ? "stale" : object.liveness,
          nextRefreshAt: addSeconds(now, DEFAULT_RETRY_AFTER_SECONDS),
          updatedAt: now,
        })
        .where(and(eq(externalObjects.id, object.id), eq(externalObjects.companyId, object.companyId)))
        .returning();
      return { object: toObjectPayload(updated ?? object, now), refreshed: false, reason: "no_resolver" as const };
    }

    const result = await resolver.resolve({ companyId: object.companyId, object });
    if (!result.ok) {
      const [updated] = await db
        .update(externalObjects)
        .set({
          liveness: result.liveness,
          lastErrorAt: now,
          lastErrorCode: result.errorCode,
          lastErrorMessage: sanitizeErrorMessage(result.errorMessage),
          nextRefreshAt: addSeconds(now, result.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS),
          updatedAt: now,
        })
        .where(and(eq(externalObjects.id, object.id), eq(externalObjects.companyId, object.companyId)))
        .returning();
      publishLiveEvent({
        companyId: object.companyId,
        type: "external_object.updated",
        payload: { objectId: object.id, liveness: result.liveness },
      });
      return { object: toObjectPayload(updated ?? object, now), refreshed: true, reason: result.liveness };
    }

    const snapshot = result.snapshot;
    const patch = {
      displayTitle: snapshot.displayTitle ?? object.displayTitle,
      statusKey: snapshot.statusKey ?? object.statusKey,
      statusLabel: snapshot.statusLabel ?? object.statusLabel,
      statusCategory: snapshot.statusCategory,
      statusTone: snapshot.statusTone,
      isTerminal: snapshot.isTerminal ?? object.isTerminal,
      data: snapshot.data ?? object.data,
      remoteVersion: snapshot.remoteVersion ?? object.remoteVersion,
      etag: snapshot.etag ?? object.etag,
      liveness: "fresh" as ExternalObjectLivenessState,
      lastResolvedAt: now,
      lastErrorAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      nextRefreshAt: addSeconds(now, snapshot.ttlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS),
      updatedAt: now,
    };
    const [updated] = await db
      .update(externalObjects)
      .set({
        ...patch,
        lastChangedAt: objectChanged(object, { ...object, ...patch }) ? now : object.lastChangedAt,
      })
      .where(and(eq(externalObjects.id, object.id), eq(externalObjects.companyId, object.companyId)))
      .returning();
    const next = updated ?? object;
    if (objectChanged(object, next) && input.actor) {
      await logActivity(db, {
        companyId: object.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "external_object.status_changed",
        entityType: "external_object",
        entityId: object.id,
        details: {
          providerKey: object.providerKey,
          objectType: object.objectType,
          statusCategory: next.statusCategory,
          statusLabel: next.statusLabel,
          _previous: {
            statusCategory: object.statusCategory,
            statusLabel: object.statusLabel,
          },
        },
      });
    }
    publishLiveEvent({
      companyId: object.companyId,
      type: "external_object.updated",
      payload: { objectId: object.id, statusCategory: next.statusCategory, liveness: next.liveness },
    });
    return { object: toObjectPayload(next, now), refreshed: true, reason: "resolved" as const };
  }

  async function refreshIssueObjects(issueId: string, input: {
    companyId: string;
    objectIds?: string[];
    actor?: Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId">;
  }) {
    const groups = await listForIssue(issueId);
    const objectIds = groups
      .flatMap((group) => (group.object ? [group.object.id] : []))
      .filter((id) => !input.objectIds || input.objectIds.includes(id));
    const results = [];
    for (const objectId of objectIds) {
      results.push(await refreshObject(objectId, { companyId: input.companyId, actor: input.actor }));
    }
    return results;
  }

  async function refreshDueObjects(companyId: string, limit = 50, now = new Date()) {
    const due = await db
      .select({ id: externalObjects.id })
      .from(externalObjects)
      .where(and(eq(externalObjects.companyId, companyId), lte(externalObjects.nextRefreshAt, now)))
      .limit(limit);
    const results = [];
    for (const row of due) {
      results.push(await refreshObject(row.id, {
        companyId,
        actor: { actorType: "system", actorId: "external-object-resolver", agentId: null, runId: null },
        now,
      }));
    }
    return results;
  }

  return {
    syncIssue,
    syncComment,
    syncDocument,
    syncIssueSafely,
    syncCommentSafely,
    syncDocumentSafely,
    listForIssue,
    getIssueSummary,
    getProjectSummary,
    refreshObject,
    refreshIssueObjects,
    refreshDueObjects,
  };
}
