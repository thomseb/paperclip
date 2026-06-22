import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const MOCK_TICKET_RE = /^https:\/\/mock\.example\/tickets\/([a-z0-9_-]+)$/i;

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Mock object provider ready");
  },

  async onDetectExternalObjects(params) {
    return {
      detections: params.urls.flatMap((url) => {
        const match = MOCK_TICKET_RE.exec(url.sanitizedCanonicalUrl);
        if (!match?.[1]) return [];
        const id = match[1].toUpperCase();
        return [{
          urlIdentityHash: url.canonicalIdentityHash,
          providerKey: "mocktracker",
          objectType: "ticket",
          externalId: `MOCK-${id}`,
          displayKey: "Mock Ticket",
          iconKey: "circle-dot",
          displayTitle: `Mock ticket ${id}`,
          confidence: "exact" as const,
        }];
      }),
    };
  },

  async onResolveExternalObject(params) {
    return {
      ok: true as const,
      snapshot: {
        displayTitle: `Resolved ${params.externalId}`,
        displayKey: "Mock Ticket",
        iconKey: "circle-dot",
        statusKey: "ready",
        statusLabel: "Ready",
        statusIconKey: "check-circle",
        statusCategory: "succeeded" as const,
        statusTone: "success" as const,
        isTerminal: false,
        data: {
          provider: "mocktracker",
          externalId: params.externalId,
        },
        ttlSeconds: 300,
      },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
