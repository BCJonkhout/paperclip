export interface TelemetryState {
  installId: string;
  salt: string;
  createdAt: string;
  firstSeenVersion: string;
}

export interface TelemetryConfig {
  enabled: boolean;
  endpoint?: string;
}

export interface TelemetryEventEnvelope {
  installId: string;
  sessionId: string;
  event: string;
  dimensions: Record<string, string | number | boolean>;
  timestamp: string;
  version: string;
  os: string;
  arch: string;
}

export type TelemetryEventName =
  | "install.started"
  | "install.completed"
  | "company.imported"
  | "agent.first_heartbeat"
  | "agent.task_completed"
  | "error.handler_crash";
