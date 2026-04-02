import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseUnknownJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function parseClawStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    const trimmed = line.trim();
    if (!trimmed) return [];
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const entries: TranscriptEntry[] = [];
  const toolUses = Array.isArray(parsed.tool_uses) ? parsed.tool_uses : [];
  const toolResults = Array.isArray(parsed.tool_results) ? parsed.tool_results : [];

  for (const entry of toolUses) {
    const record = asRecord(entry);
    if (!record) continue;
    const toolUseId = asString(record.id, "");
    const name = asString(record.name, "tool");
    entries.push({
      kind: "tool_call",
      ts,
      name,
      input: parseUnknownJsonString(record.input),
      ...(toolUseId ? { toolUseId } : {}),
    });
  }

  for (const entry of toolResults) {
    const record = asRecord(entry);
    if (!record) continue;
    const toolUseId = asString(record.tool_use_id, "");
    if (!toolUseId) continue;
    entries.push({
      kind: "tool_result",
      ts,
      toolUseId,
      toolName: asString(record.tool_name, "tool"),
      content: asString(record.output, ""),
      isError: record.is_error === true,
    });
  }

  const message = asString(parsed.message, "").trim();
  if (message) {
    entries.push({
      kind: "assistant",
      ts,
      text: message,
    });
  }

  const usage = asRecord(parsed.usage);
  if (message || usage) {
    entries.push({
      kind: "result",
      ts,
      text: message || "Claw run completed",
      inputTokens: asNumber(usage?.input_tokens, 0),
      outputTokens: asNumber(usage?.output_tokens, 0),
      cachedTokens: asNumber(usage?.cache_read_input_tokens, 0),
      costUsd: 0,
      subtype: `iterations:${asNumber(parsed.iterations, 0)}`,
      isError: false,
      errors: [],
    });
  }

  return entries;
}
