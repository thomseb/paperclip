import type { ReactNode } from "react";
import type {
  ExternalObjectLivenessState,
  ExternalObjectStatusCategory,
} from "@paperclipai/shared";
import { ExternalObjectStatusIcon } from "./ExternalObjectStatusIcon";
import {
  externalObjectStatusIcon,
  externalObjectStatusIconDefault,
  externalObjectLivenessOverlay,
} from "../lib/status-colors";
import {
  externalObjectCategoryLabel,
  externalObjectLivenessLabel,
  externalObjectProviderLabel,
  externalObjectTypeLabel,
} from "../lib/external-objects";
import { cn } from "../lib/utils";

export interface ExternalObjectPillData {
  providerKey: string | null;
  objectType: string | null;
  statusCategory: ExternalObjectStatusCategory;
  liveness: ExternalObjectLivenessState;
  displayTitle?: string | null;
  statusLabel?: string | null;
  url?: string | null;
}

interface ExternalObjectPillProps {
  object: ExternalObjectPillData;
  /** Optional external mention count (renders as `×N` superscript when > 1). */
  sourceCount?: number;
  /** Optional source-mention summary used as the pill's `title` attribute. */
  sourceSummary?: string | null;
  className?: string;
  /** Optional rendered label override. Defaults to `provider object-type`. */
  children?: ReactNode;
  /**
   * If true the pill renders without a hover treatment (used inside
   * non-interactive contexts like the property panel). Defaults to false.
   */
  inert?: boolean;
}

/**
 * External-object equivalent of `IssueReferencePill`. Same `paperclip-mention-chip`
 * base so external references feel native to readers (Jakob's Law).
 */
export function ExternalObjectPill({
  object,
  sourceCount,
  sourceSummary,
  className,
  children,
  inert,
}: ExternalObjectPillProps) {
  const tone = externalObjectStatusIcon[object.statusCategory] ?? externalObjectStatusIconDefault;
  const overlay = externalObjectLivenessOverlay[object.liveness] ?? "";
  const providerLabel = externalObjectProviderLabel(object.providerKey);
  const typeLabel = externalObjectTypeLabel(object.objectType);
  const statusLabel = object.statusLabel ?? externalObjectCategoryLabel(object.statusCategory);
  const livenessLabel = externalObjectLivenessLabel(object.liveness);
  const ariaLabel = `${providerLabel} ${typeLabel} — ${statusLabel}${
    object.liveness === "fresh" || object.liveness === "unknown" ? "" : ` (${livenessLabel})`
  }${object.displayTitle ? `: ${object.displayTitle}` : ""}`;

  const interactive = !inert && Boolean(object.url);
  const classNames = cn(
    "paperclip-mention-chip paperclip-mention-chip--external-object",
    "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs no-underline",
    // Tone is applied as text classes only — the border style comes from the
    // overlay (dashed for stale/auth/unreachable).
    tone.split(" ").filter((c) => c.startsWith("text-")).join(" "),
    overlay,
    interactive
      && "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
    className,
  );
  const titleAttr = sourceSummary
    ? `${object.displayTitle ?? `${providerLabel} ${typeLabel}`} — ${sourceSummary}`
    : object.displayTitle ?? `${providerLabel} ${typeLabel}`;
  const labelText = children ?? (
    <>
      <span className="font-medium">{providerLabel.toLowerCase()}</span>
      <span className="text-muted-foreground/80">{typeLabel}</span>
    </>
  );
  const countSuffix = typeof sourceCount === "number" && sourceCount > 1 ? (
    <span className="tabular-nums text-[10px] font-medium opacity-80">×{sourceCount}</span>
  ) : null;
  const innerContent = (
    <>
      <ExternalObjectStatusIcon
        category={object.statusCategory}
        liveness={object.liveness}
        sizeClassName="h-3 w-3"
        label={`${providerLabel}: ${statusLabel}`}
      />
      <span className="inline-flex items-center gap-1">
        {labelText}
      </span>
      {countSuffix}
    </>
  );

  if (interactive && object.url) {
    return (
      <a
        href={object.url}
        target="_blank"
        rel="noopener noreferrer"
        data-mention-kind="external-object"
        data-external-status={object.statusCategory}
        data-external-liveness={object.liveness}
        className={classNames}
        title={titleAttr}
        aria-label={ariaLabel}
      >
        {innerContent}
      </a>
    );
  }

  return (
    <span
      data-mention-kind="external-object"
      data-external-status={object.statusCategory}
      data-external-liveness={object.liveness}
      className={classNames}
      title={titleAttr}
      aria-label={ariaLabel}
    >
      {innerContent}
    </span>
  );
}
