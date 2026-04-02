import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  renderTemplate,
  resolveCommandForLogs,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { parseClawJson } from "./parse.js";

const CLAW_PERMISSION_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function normalizePermissionMode(value: string): "read-only" | "workspace-write" | "danger-full-access" {
  const normalized = value.trim().toLowerCase();
  if (CLAW_PERMISSION_MODES.has(normalized)) {
    return normalized as "read-only" | "workspace-write" | "danger-full-access";
  }
  return "workspace-write";
}

function inferProviderFromModel(model: string | null): string | null {
  if (!model) return null;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("gemini")) return "google";
  if (normalized.startsWith("claude")) return "anthropic";
  if (normalized.startsWith("gpt") || normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4")) {
    return "openai";
  }
  return null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const command = asString(config.command, "claw");
  const model = asString(config.model, "").trim();
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const permissionMode = normalizePermissionMode(
    asString(
      config.permissionMode,
      asBoolean(config.dangerouslyBypassSandbox, false)
        ? "danger-full-access"
        : "workspace-write",
    ),
  );

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (workspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = workspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionId = asString(parseObject(runtime.sessionParams).sessionId, runtime.sessionId ?? "");
  if (runtimeSessionId) {
    await onLog(
      "stdout",
      `[paperclip] claw_local does not support session resume yet; ignoring saved session "${runtimeSessionId}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath ? path.resolve(cwd, instructionsFilePath) : "";
  const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (resolvedInstructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt = bootstrapPromptTemplate.trim().length > 0
    ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
    : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  const commandNotes = [
    "Prompt is passed to Claw via non-interactive JSON mode (`claw prompt ...`).",
    `Permission mode: ${permissionMode}.`,
    ...(dangerouslySkipPermissions ? ["Added --dangerously-skip-permissions for unattended execution."] : []),
    ...(instructionsPrefix
      ? [
          `Loaded agent instructions from ${resolvedInstructionsFilePath}`,
          `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
        ]
      : resolvedInstructionsFilePath
        ? [
            `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
          ]
        : []),
    "claw_local currently starts a fresh non-interactive run on each heartbeat.",
  ];

  const args = [
    ...(model ? ["--model", model] : []),
    "--output-format",
    "json",
    "--permission-mode",
    permissionMode,
    ...(dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
    ...extraArgs,
    "prompt",
    prompt,
  ];

  if (onMeta) {
    await onMeta({
      adapterType: "claw_local",
      command: resolvedCommand,
      cwd,
      commandNotes,
      commandArgs: args.map((value, index) => (
        index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value
      )),
      env: loggedEnv,
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        instructionsChars: instructionsPrefix.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onSpawn,
    onLog,
  });
  const parsed = parseClawJson(proc.stdout);
  const provider = inferProviderFromModel((parsed.model ?? model) || null);

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage:
      proc.timedOut
        ? `Timed out after ${timeoutSec}s`
        : parsed.errorMessage ?? (proc.exitCode === 0 ? null : firstNonEmptyLine(proc.stderr) || firstNonEmptyLine(proc.stdout) || null),
    usage: parsed.usage,
    provider,
    biller: provider,
    model: (parsed.model ?? model) || null,
    billingType: "unknown",
    resultJson: parsed.raw,
    summary: parsed.message,
    clearSession: true,
  };
}
