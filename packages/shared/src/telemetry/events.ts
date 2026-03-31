import type { TelemetryClient } from "./client.js";

export function trackInstallStarted(client: TelemetryClient, dims: { setupMode: string }): void {
  client.track("install.started", dims);
}

export function trackInstallCompleted(
  client: TelemetryClient,
  dims: { setupMode: string; dbMode: string; deploymentMode: string },
): void {
  client.track("install.completed", dims);
}

export function trackCompanyImported(
  client: TelemetryClient,
  dims: { sourceType: string; sourceRef: string; isPrivate: boolean },
): void {
  const ref = dims.isPrivate ? client.hashPrivateRef(dims.sourceRef) : dims.sourceRef;
  client.track("company.imported", {
    sourceType: dims.sourceType,
    sourceRef: ref,
    sourceRefHashed: dims.isPrivate,
  });
}

export function trackAgentFirstHeartbeat(
  client: TelemetryClient,
  dims: { adapterType: string },
): void {
  client.track("agent.first_heartbeat", dims);
}

export function trackAgentTaskCompleted(
  client: TelemetryClient,
  dims: { adapterType: string },
): void {
  client.track("agent.task_completed", dims);
}

export function trackErrorHandlerCrash(
  client: TelemetryClient,
  dims: { errorName: string; route: string; method: string },
): void {
  client.track("error.handler_crash", {
    errorName: dims.errorName,
    route: dims.route,
    method: dims.method,
  });
}
