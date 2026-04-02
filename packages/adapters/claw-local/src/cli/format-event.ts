import pc from "picocolors";
import { parseClawJson } from "../server/parse.js";

export function printClawStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = parseClawJson(line);
  if (!parsed.raw) {
    console.log(line);
    return;
  }

  if (parsed.model) {
    console.log(pc.blue(`Claw result (model: ${parsed.model})`));
  } else {
    console.log(pc.blue("Claw result"));
  }

  for (const toolCall of parsed.toolCalls) {
    console.log(pc.yellow(`tool_call: ${toolCall.toolName}`));
    if (toolCall.input !== null && toolCall.input !== undefined) {
      try {
        console.log(pc.gray(JSON.stringify(toolCall.input, null, 2)));
      } catch {
        console.log(pc.gray(String(toolCall.input)));
      }
    }
    if (toolCall.result) {
      console.log((toolCall.isError ? pc.red : pc.cyan)(`tool_result${toolCall.isError ? " (error)" : ""}`));
      console.log((toolCall.isError ? pc.red : pc.gray)(toolCall.result));
    }
  }

  if (parsed.message) {
    console.log(pc.green(`assistant: ${parsed.message}`));
  }

  console.log(
    pc.blue(
      `tokens: in=${parsed.usage.inputTokens} out=${parsed.usage.outputTokens} cached=${parsed.usage.cachedInputTokens} iterations=${parsed.iterations}`,
    ),
  );

  if (parsed.errorMessage) {
    console.log(pc.red(`error: ${parsed.errorMessage}`));
  }
}
