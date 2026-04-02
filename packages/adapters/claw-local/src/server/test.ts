import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asString,
  asStringArray,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";
import { parseClawJson } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

const CLAW_AUTH_REQUIRED_RE =
  /(?:not\s+authenticated|authentication\s+required|invalid\s+api\s*key|please\s+run\s+`?claw\s+login`?|manual authorization is required)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "claw");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "claw_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "claw_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "claw_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "claw_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "claw_cwd_invalid" && check.code !== "claw_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "claw")) {
      checks.push({
        code: "claw_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `claw`.",
        detail: command,
      });
    } else {
      const model = asString(config.model, "").trim();
      const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
      const permissionMode = asString(config.permissionMode, "workspace-write").trim() || "workspace-write";
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = [
        ...(model ? ["--model", model] : []),
        "--output-format",
        "json",
        "--permission-mode",
        permissionMode,
        ...(dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
        ...extraArgs,
        "prompt",
        "Respond with hello.",
      ];

      const probe = await runChildProcess(
        `claw-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          onLog: async () => {},
        },
      );
      const parsed = parseClawJson(probe.stdout);
      const detail = parsed.errorMessage || probe.stderr.trim() || probe.stdout.trim();
      const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`;

      if (probe.timedOut) {
        checks.push({
          code: "claw_hello_probe_timed_out",
          level: "warn",
          message: "Claw hello probe timed out.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const hasHello = /\bhello\b/i.test(parsed.message ?? "");
        checks.push({
          code: hasHello ? "claw_hello_probe_passed" : "claw_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Claw hello probe succeeded."
            : "Claw probe ran but did not return `hello` as expected.",
          detail: parsed.message ?? null,
        });
      } else if (CLAW_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "claw_hello_probe_auth_required",
          level: "warn",
          message: "Claw CLI is installed, but authentication is not ready.",
          detail,
          hint: "Run `claw login` or configure the underlying provider auth for the current Claw profile, then retry.",
        });
      } else {
        checks.push({
          code: "claw_hello_probe_failed",
          level: "error",
          message: "Claw hello probe failed.",
          detail,
          hint: "Run `claw --output-format json prompt \"Respond with hello.\"` manually in this working directory to debug.",
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
