import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

export type ClawToolCall = {
  toolUseId: string;
  toolName: string;
  input: unknown;
  result: string | null;
  isError: boolean;
};

export type ParsedClawOutput = {
  iterations: number;
  message: string | null;
  model: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  toolCalls: ClawToolCall[];
  errorMessage: string | null;
  raw: Record<string, unknown> | null;
};

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function parseClawJson(stdout: string): ParsedClawOutput {
  let payload: Record<string, unknown> | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseObject(parseJson(line));
    if (parsed) payload = parsed;
  }

  if (!payload) {
    return {
      iterations: 0,
      message: null,
      model: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
      },
      toolCalls: [],
      errorMessage: null,
      raw: null,
    };
  }

  const toolCallsById = new Map<string, ClawToolCall>();
  const toolUses = Array.isArray(payload.tool_uses) ? payload.tool_uses : [];
  const toolResults = Array.isArray(payload.tool_results) ? payload.tool_results : [];

  for (const entry of toolUses) {
    const record = parseObject(entry);
    if (!record) continue;
    const toolUseId = asString(record.id, "");
    const toolName = asString(record.name, "");
    if (!toolUseId || !toolName) continue;
    toolCallsById.set(toolUseId, {
      toolUseId,
      toolName,
      input: parseJsonString(record.input),
      result: null,
      isError: false,
    });
  }

  for (const entry of toolResults) {
    const record = parseObject(entry);
    if (!record) continue;
    const toolUseId = asString(record.tool_use_id, "");
    const toolName = asString(record.tool_name, "");
    const isError = record.is_error === true;
    const output = asString(record.output, "");

    const existing = toolUseId ? toolCallsById.get(toolUseId) : null;
    if (existing) {
      existing.result = output || existing.result;
      existing.isError = isError;
      continue;
    }

    const fallbackId = toolUseId || `tool-${toolCallsById.size + 1}`;
    toolCallsById.set(fallbackId, {
      toolUseId: fallbackId,
      toolName: toolName || "tool",
      input: null,
      result: output || null,
      isError,
    });
  }

  const usage = parseObject(payload.usage);
  return {
    iterations: asNumber(payload.iterations, 0),
    message: asString(payload.message, "").trim() || null,
    model: asString(payload.model, "").trim() || null,
    usage: {
      inputTokens: asNumber(usage?.input_tokens, 0),
      outputTokens: asNumber(usage?.output_tokens, 0),
      cachedInputTokens: asNumber(usage?.cache_read_input_tokens, 0),
    },
    toolCalls: Array.from(toolCallsById.values()),
    errorMessage: asString(payload.error, "").trim() || null,
    raw: payload,
  };
}
