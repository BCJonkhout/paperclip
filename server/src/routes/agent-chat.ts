import { Router } from "express";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, heartbeatRuns, issueWorkProducts } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getServerAdapter } from "../adapters/index.js";
import {
  agentService,
  issueService,
  documentService,
  secretService,
} from "../services/index.js";
import { notFound } from "../errors.js";
import { parseObject } from "../adapters/utils.js";

/**
 * Detect if the CEO's response commits to creating an artifact.
 * Returns a list of artifacts to create. Simple pattern matching —
 * reliable and instant, no AI call needed.
 */
function detectArtifactCommitments(response: string): Array<{ title: string; status: string }> {
  const artifacts: Array<{ title: string; status: string }> = [];
  const lower = response.toLowerCase();

  // Hiring plan commitment
  if (
    (/(?:i'll|i will|let me|going to)\s+(?:put together|draft|create|build|start|work on)/i.test(response) &&
      /hiring\s*plan|team\s*plan/i.test(response)) ||
    (/hiring\s*plan/i.test(response) && /(?:right away|now|started|on it)/i.test(response))
  ) {
    artifacts.push({ title: "Hiring Plan", status: "in_progress" });
  }

  // Strategy document commitment
  if (
    /(?:i'll|i will|let me|going to)\s+(?:put together|draft|create|build|write)/i.test(response) &&
    /strateg(?:y|ic)\s*(?:doc|document|plan|brief)/i.test(response)
  ) {
    artifacts.push({ title: "Strategy Document", status: "in_progress" });
  }

  return artifacts;
}

/**
 * Chat relay endpoint — calls the adapter directly and streams the response
 * back via SSE. Bypasses the heartbeat queue for real-time conversation.
 *
 * Comments are persisted normally so the conversation is durable.
 */
export function agentChatRoutes(db: Db) {
  const router = Router();

  router.post("/agents/:id/chat/relay", async (req, res) => {
    const agentId = req.params.id;
    const { taskId, message } = req.body as { taskId: string; message: string };

    if (!taskId || !message) {
      res.status(400).json({ error: "taskId and message are required" });
      return;
    }

    // Look up agent
    const agentSvc = agentService(db);
    const agent = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      throw notFound("Agent not found");
    }

    // Save the user's message as a comment
    const issueSvc = issueService(db);
    await issueSvc.addComment(taskId, message, {
      userId: (req as any).actor?.userId ?? null,
    });

    // Set up SSE streaming response
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // Send initial event
    res.write(`data: ${JSON.stringify({ type: "start", agentId, agentName: agent.name })}\n\n`);

    // Create runId upfront so it's accessible in catch block
    const runId = randomUUID();

    try {
      // Resolve adapter config with secrets
      const config = parseObject(agent.adapterConfig);
      const secretsSvc = secretService(db);
      const { config: resolvedConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        agent.companyId,
        config,
      );

      // Get adapter
      const adapter = getServerAdapter(agent.adapterType);

      // Create a heartbeat run record so the agent can use the runId in API calls
      // (activity_log.run_id has a FK to heartbeat_runs)
      const now = new Date();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: agent.companyId,
        agentId: agent.id,
        invocationSource: "chat_relay",
        triggerDetail: `chat_relay:${taskId}`,
        status: "running",
        startedAt: now,
      });

      // Execute directly — stream stdout chunks as SSE events
      let fullResponse = "";
      const startTime = Date.now();

      const result = await adapter.execute({
        runId,
        agent: agent as any, // DB row matches adapter expectation
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: resolvedConfig,
        context: {
          chatMessage: message,
          taskId,
          issueId: taskId,
          source: "chat_relay",
          wakeReason: "chat_relay",
        },
        onLog: async (stream, chunk) => {
          if (stream === "stdout" && res.writable) {
            fullResponse += chunk;
            res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
          }
        },
        onMeta: async () => {
          // Silently consume metadata
        },
      });

      // Finalize the heartbeat run
      await db
        .update(heartbeatRuns)
        .set({
          status: result.exitCode === 0 ? "completed" : "failed",
          finishedAt: new Date(),
          exitCode: result.exitCode,
          resultJson: {
            model: result.model ?? null,
            provider: result.provider ?? null,
            costUsd: result.costUsd ?? null,
          },
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      // Save the agent's full response as a comment
      if (fullResponse.trim()) {
        await issueSvc.addComment(taskId, fullResponse.trim(), {
          agentId: agent.id,
        });
      }

      // Send completion event
      const duration = Date.now() - startTime;
      if (res.writable) {
        res.write(
          `data: ${JSON.stringify({
            type: "done",
            model: result.model ?? null,
            provider: result.provider ?? null,
            costUsd: result.costUsd ?? null,
            duration,
            exitCode: result.exitCode,
          })}\n\n`,
        );
      }
    } catch (err) {
      // Mark the run as failed on error (best-effort)
      await db
        .update(heartbeatRuns)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: err instanceof Error ? err.message : "Relay execution failed",
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId))
        .catch(() => {});
      // Send error event
      if (res.writable) {
        const message = err instanceof Error ? err.message : "Relay execution failed";
        res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
      }
    } finally {
      if (res.writable) {
        res.end();
      }
    }
  });

  /**
   * Save a canned/simulated response as an agent comment.
   * Used by the frontend to persist instant responses.
   */
  router.post("/agents/:id/chat/canned", async (req, res) => {
    const agentId = req.params.id;
    const { taskId, message } = req.body as { taskId: string; message: string };

    if (!taskId || !message) {
      res.status(400).json({ error: "taskId and message are required" });
      return;
    }

    const agent = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      throw notFound("Agent not found");
    }

    const issueSvc = issueService(db);
    const comment = await issueSvc.addComment(taskId, message, {
      agentId: agent.id,
    });

    res.json(comment);
  });

  /**
   * Generate an artifact document in the background.
   * Called by the frontend after the observer detects an artifact to create.
   * Spawns claude to generate the content, saves it as a document,
   * and updates the work product status.
   */
  router.post("/agents/:id/chat/generate-artifact", async (req, res) => {
    const agentId = req.params.id;
    const { taskId, artifactTitle, workProductId, conversationContext } = req.body as {
      taskId: string;
      artifactTitle: string;
      workProductId: string;
      conversationContext: string;
    };

    if (!taskId || !artifactTitle) {
      res.status(400).json({ error: "taskId and artifactTitle are required" });
      return;
    }

    const agent = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      throw notFound("Agent not found");
    }

    // Respond immediately — generation happens in background
    res.json({ status: "generating" });

    // Generate document in background
    const docKey = artifactTitle.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const prompt = `You are ${agent.name}, CEO of a company. Based on the conversation below, create a detailed, well-structured "${artifactTitle}" document in markdown format.

CONVERSATION CONTEXT:
${conversationContext}

Write the "${artifactTitle}" now. Be specific, actionable, and thorough. Use markdown headings, bullet points, and clear structure. Do not include any preamble — start directly with the document content.`;

    const proc = spawn("claude", [
      "-p", prompt,
      "--output-format", "json",
      "--model", "sonnet",
      "--no-session-persistence",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/tmp",
      env: { ...process.env },
    });

    let output = "";
    const timeout = setTimeout(() => proc.kill("SIGTERM"), 120000);

    proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => {
      console.error("[generate-artifact stderr]", data.toString());
    });

    proc.on("close", async () => {
      clearTimeout(timeout);
      const docsSvc = documentService(db);
      const issueSvc = issueService(db);

      try {
        // Parse the result
        let docContent = "";
        try {
          const parsed = JSON.parse(output);
          docContent = parsed.result ?? output;
        } catch {
          docContent = output;
        }

        if (!docContent.trim()) return;

        // Save as document
        await docsSvc.upsertIssueDocument({
          issueId: taskId,
          key: docKey,
          title: artifactTitle,
          format: "markdown",
          body: docContent.trim(),
          createdByAgentId: agent.id,
        });

        // Update work product to ready_for_review
        if (workProductId) {
          await db
            .update(issueWorkProducts)
            .set({
              status: "ready_for_review",
              reviewState: "needs_board_review",
              summary: `${artifactTitle} is ready for your review`,
              updatedAt: new Date(),
            })
            .where(eq(issueWorkProducts.id, workProductId));
        }
      } catch (err) {
        console.error("[generate-artifact] failed:", err);
      }
    });
  });

  /**
   * Lightweight chat endpoint — spawns `claude` CLI directly, bypassing
   * the adapter pipeline. Streams response via SSE. Much faster cold start.
   */
  router.post("/agents/:id/chat/stream", async (req, res) => {
    const agentId = req.params.id;
    const { taskId, message } = req.body as { taskId: string; message: string };

    if (!taskId || !message) {
      res.status(400).json({ error: "taskId and message are required" });
      return;
    }

    // Look up agent
    const agent = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      throw notFound("Agent not found");
    }

    // Save user message as comment
    const issueSvc = issueService(db);
    await issueSvc.addComment(taskId, message, {
      userId: (req as any).actor?.userId ?? null,
    });

    // Build conversation history from recent comments
    const comments = await issueSvc.listComments(taskId);
    const sorted = [...comments].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const recent = sorted.slice(-20);
    const history = recent
      .map((c) => {
        const role = c.authorAgentId ? "CEO" : "USER";
        return `${role}: ${c.body}`;
      })
      .join("\n\n");

    // Build system prompt from agent instructions file or inline
    const config = parseObject(agent.adapterConfig);
    let systemPrompt = `You are ${agent.name}, the CEO of this company. The user is the board of directors.

IMPORTANT RULES:
- Be conversational, strategic, and concise.
- When the board asks you to create something (a hiring plan, strategy doc, etc.), respond with a SHORT acknowledgment (1-2 sentences max). Do NOT write the full document in chat. Just confirm you'll start working on it. The system will handle document creation separately.
- When discussing strategy, priorities, or giving advice, be thorough and helpful.
- Never reference tools, files, code, or technical systems. You are a CEO, not an engineer.`;
    const instructionsPath = (config as any).instructionsFilePath;
    if (instructionsPath && typeof instructionsPath === "string") {
      try {
        const instructions = fs.readFileSync(instructionsPath, "utf-8");
        systemPrompt = instructions;
      } catch {
        // Fall back to default
      }
    }

    // Compose the prompt with conversation history
    const prompt = history
      ? `Here is the conversation so far:\n\n${history}\n\nRespond to the latest message from the user.`
      : message;

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: "start", agentId, agentName: agent.name })}\n\n`);

    // Spawn claude CLI directly — no adapter overhead
    const args = [
      "-p", "-",
      "--output-format", "stream-json",
      "--verbose",
      "--append-system-prompt", systemPrompt,
      "--model", "sonnet",
      "--no-session-persistence",
    ];

    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/tmp", // Run in neutral directory so Claude doesn't read project files
      env: { ...process.env },
    });

    let fullResponse = "";
    const startTime = Date.now();
    let killed = false;

    // 60s timeout
    const timeout = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, 60000);

    // Stream stdout — parse stream-json events
    let stdoutBuf = "";
    proc.stdout.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // stream-json emits objects with type: "assistant", "result", etc.
          // Text content comes in assistant messages
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text" && block.text && res.writable) {
                fullResponse += block.text;
                res.write(`data: ${JSON.stringify({ type: "chunk", text: block.text })}\n\n`);
              }
            }
          } else if (event.type === "content_block_delta" && event.delta?.text) {
            fullResponse += event.delta.text;
            if (res.writable) {
              res.write(`data: ${JSON.stringify({ type: "chunk", text: event.delta.text })}\n\n`);
            }
          } else if (event.type === "result" && event.result && !fullResponse) {
            // Fallback: if we missed the assistant message, grab from result
            fullResponse = event.result;
            if (res.writable) {
              res.write(`data: ${JSON.stringify({ type: "chunk", text: event.result })}\n\n`);
            }
          }
        } catch {
          // Not JSON or unknown format — skip
        }
      }
    });

    // Log stderr for debugging
    proc.stderr.on("data", (data: Buffer) => {
      console.error("[chat/stream stderr]", data.toString());
    });

    proc.on("close", async (exitCode) => {
      clearTimeout(timeout);

      // Save full response as agent comment
      if (fullResponse.trim()) {
        try {
          await issueSvc.addComment(taskId, fullResponse.trim(), {
            agentId: agent.id,
          });
        } catch { /* best effort */ }
      }

      // Send completion event
      const duration = Date.now() - startTime;
      if (res.writable) {
        res.write(
          `data: ${JSON.stringify({
            type: "done",
            duration,
            exitCode: exitCode ?? 0,
            timedOut: killed,
          })}\n\n`,
        );
      }

      // Detect if the CEO committed to creating an artifact
      const artifacts = detectArtifactCommitments(fullResponse);
      if (artifacts.length > 0 && res.writable) {
        res.write(`data: ${JSON.stringify({ type: "observer", actions: { artifacts, tasks: [] } })}\n\n`);
      }
      if (res.writable) res.end();
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      if (res.writable) {
        res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
        res.end();
      }
    });

    // Pipe the prompt to stdin
    proc.stdin.write(prompt);
    proc.stdin.end();
  });

  return router;
}
