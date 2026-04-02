export const type = "claw_local";
export const label = "Claw Code (local)";

export const models = [
  { id: "gemini", label: "gemini" },
  { id: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview" },
  { id: "gemini-3-flash-preview", label: "gemini-3-flash-preview" },
];

export const agentConfigurationDoc = `# claw_local agent configuration

Adapter: claw_local

Use when:
- You want Paperclip to run Claw Code locally as the coding-agent runtime
- You want headless JSON-mode runs through the installed \`claw\` CLI
- You want per-agent instructions injected into the Claw prompt on every run
- You want a local coding agent that can edit the active workspace

Current limitation:
- This adapter currently runs Claw in one-shot non-interactive mode per heartbeat.
- Session resume/continuity is not implemented yet.

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt
- promptTemplate (string, optional): run prompt template
- bootstrapPromptTemplate (string, optional): legacy bootstrap prompt (replayed when no saved session exists; claw_local currently has no session resume)
- model (string, optional): Claw model override. Leave blank to use Claw's local default model.
- dangerouslySkipPermissions (boolean, optional): pass --dangerously-skip-permissions for unattended execution
- permissionMode (string, optional): Claw permission mode (read-only | workspace-write | danger-full-access)
- command (string, optional): defaults to "claw"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy metadata
- workspaceRuntime (object, optional): reserved for workspace runtime metadata

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Prompt execution uses \`claw --output-format json prompt "<prompt>"\`.
- \`permissionMode\` defaults to \`workspace-write\`. When the UI "Bypass sandbox" toggle is enabled, Paperclip stores \`danger-full-access\`.
- Claw settings (for example the default model) are read from the local Claw home on the machine running Paperclip.
`;
