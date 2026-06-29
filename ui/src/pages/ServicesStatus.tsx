import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, RefreshCw, Server } from "lucide-react";
import { servicesApi, type ServiceStatus } from "../api/services";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function StatusPill({ status }: { status: ServiceStatus["status"] }) {
  const up = status === "up";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        up
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
          : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
      )}
    >
      {up ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {up ? "Online" : "Offline"}
    </span>
  );
}

function ServiceCard({ service }: { service: ServiceStatus }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="text-base">{service.name}</CardTitle>
          <CardDescription className="mt-1">{service.description}</CardDescription>
        </div>
        <StatusPill status={service.status} />
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Endpoint</span>
          <span className="font-mono text-xs truncate">{service.url}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Latency</span>
          <span className="font-mono text-xs">
            {service.latencyMs != null ? `${service.latencyMs} ms` : "—"}
          </span>
        </div>
        {service.error && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Error</span>
            <span className="font-mono text-xs text-red-600 dark:text-red-400 truncate">
              {service.error}
            </span>
          </div>
        )}
        {service.status === "up" && service.detail != null && (
          <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-[11px] leading-relaxed">
            {JSON.stringify(service.detail, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

export function ServicesStatus() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Services" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const query = useQuery({
    queryKey: ["services", "status"],
    queryFn: () => servicesApi.status(),
    refetchInterval: 10_000,
  });

  if (query.isLoading) {
    return <PageSkeleton />;
  }

  const services = query.data?.services ?? [];
  const upCount = services.filter((s) => s.status === "up").length;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Server className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold">Services</h1>
            <p className="text-sm text-muted-foreground">
              {upCount} of {services.length} companion services online
              {query.data?.checkedAt && (
                <> · checked {new Date(query.data.checkedAt).toLocaleTimeString()}</>
              )}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw className={cn("h-4 w-4", query.isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {query.error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Failed to load service status:{" "}
          {query.error instanceof Error ? query.error.message : "Unknown error"}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {services.map((service) => (
            <ServiceCard key={service.key} service={service} />
          ))}
        </div>
      )}
    </div>
  );
}
