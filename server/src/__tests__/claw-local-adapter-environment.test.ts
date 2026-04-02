import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-claw-local/server";

async function writeFakeClawCommand(binDir: string, argsCapturePath: string): Promise<string> {
  const commandPath = path.join(binDir, "claw");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const outPath = process.env.PAPERCLIP_TEST_ARGS_PATH;
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(process.argv.slice(2)), "utf8");
}
console.log(JSON.stringify({
  iterations: 1,
  message: "hello",
  model: "gemini-3.1-pro-preview",
  tool_uses: [],
  tool_results: [],
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("claw_local environment diagnostics", () => {
  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-claw-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claw_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "claw_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("passes model and permission flags to the hello probe", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-claw-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const argsCapturePath = path.join(root, "args.json");
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeClawCommand(binDir, argsCapturePath);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claw_local",
      config: {
        command: "claw",
        cwd,
        model: "gemini-3-flash-preview",
        dangerouslySkipPermissions: true,
        permissionMode: "danger-full-access",
        env: {
          PAPERCLIP_TEST_ARGS_PATH: argsCapturePath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "claw_hello_probe_passed")).toBe(true);
    const args = JSON.parse(await fs.readFile(argsCapturePath, "utf8")) as string[];
    expect(args).toContain("--model");
    expect(args).toContain("gemini-3-flash-preview");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("danger-full-access");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("prompt");
    await fs.rm(root, { recursive: true, force: true });
  });
});
