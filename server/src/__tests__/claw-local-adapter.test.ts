import { describe, expect, it, vi } from "vitest";
import { parseClawJson } from "@paperclipai/adapter-claw-local/server";
import { parseClawStdoutLine } from "@paperclipai/adapter-claw-local/ui";
import { printClawStreamEvent } from "@paperclipai/adapter-claw-local/cli";

describe("claw_local parser", () => {
  it("extracts message, model, usage, and tool activity", () => {
    const stdout = JSON.stringify({
      iterations: 2,
      message: "done.",
      model: "gemini-3.1-pro-preview",
      tool_uses: [
        {
          id: "tool-1",
          name: "write_file",
          input: JSON.stringify({ path: "hello.txt", content: "hi" }),
        },
      ],
      tool_results: [
        {
          tool_use_id: "tool-1",
          tool_name: "write_file",
          output: JSON.stringify({ type: "create", filePath: "/tmp/hello.txt" }),
          is_error: false,
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 2,
      },
    });

    const parsed = parseClawJson(stdout);
    expect(parsed.iterations).toBe(2);
    expect(parsed.message).toBe("done.");
    expect(parsed.model).toBe("gemini-3.1-pro-preview");
    expect(parsed.usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cachedInputTokens: 2,
    });
    expect(parsed.toolCalls).toEqual([
      {
        toolUseId: "tool-1",
        toolName: "write_file",
        input: { path: "hello.txt", content: "hi" },
        result: JSON.stringify({ type: "create", filePath: "/tmp/hello.txt" }),
        isError: false,
      },
    ]);
  });
});

describe("claw_local ui stdout parser", () => {
  it("emits tool, assistant, and result entries", () => {
    const ts = "2026-04-02T00:00:00.000Z";
    const entries = parseClawStdoutLine(
      JSON.stringify({
        iterations: 2,
        message: "done.",
        model: "gemini-3.1-pro-preview",
        tool_uses: [
          {
            id: "tool-1",
            name: "write_file",
            input: JSON.stringify({ path: "hello.txt", content: "hi" }),
          },
        ],
        tool_results: [
          {
            tool_use_id: "tool-1",
            tool_name: "write_file",
            output: "{\"type\":\"create\"}",
            is_error: false,
          },
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_read_input_tokens: 2,
        },
      }),
      ts,
    );

    expect(entries).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "write_file",
        input: { path: "hello.txt", content: "hi" },
        toolUseId: "tool-1",
      },
      {
        kind: "tool_result",
        ts,
        toolUseId: "tool-1",
        toolName: "write_file",
        content: "{\"type\":\"create\"}",
        isError: false,
      },
      {
        kind: "assistant",
        ts,
        text: "done.",
      },
      {
        kind: "result",
        ts,
        text: "done.",
        inputTokens: 12,
        outputTokens: 7,
        cachedTokens: 2,
        costUsd: 0,
        subtype: "iterations:2",
        isError: false,
        errors: [],
      },
    ]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("claw_local cli formatter", () => {
  it("prints tool activity and the final assistant message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let joined = "";

    try {
      printClawStreamEvent(
        JSON.stringify({
          iterations: 2,
          message: "done.",
          model: "gemini-3.1-pro-preview",
          tool_uses: [
            {
              id: "tool-1",
              name: "write_file",
              input: JSON.stringify({ path: "hello.txt", content: "hi" }),
            },
          ],
          tool_results: [
            {
              tool_use_id: "tool-1",
              tool_name: "write_file",
              output: "{\"type\":\"create\"}",
              is_error: false,
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 7,
            cache_read_input_tokens: 2,
          },
        }),
        false,
      );
      joined = spy.mock.calls.map((call) => stripAnsi(call.join(" "))).join("\n");
    } finally {
      spy.mockRestore();
    }

    expect(joined).toContain("Claw result");
    expect(joined).toContain("tool_call: write_file");
    expect(joined).toContain("assistant: done.");
    expect(joined).toContain("tokens: in=12 out=7 cached=2 iterations=2");
  });
});
