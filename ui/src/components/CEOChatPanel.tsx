import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueComment } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "./MarkdownBody";
import { cn } from "../lib/utils";
import {
  Loader2,
  Send,
  CheckCircle2,
  History,
  Search,
  X,
  Plus,
} from "lucide-react";

export interface ChatConversation {
  id: string;
  title: string;
  lastMessage?: string;
  updatedAt: string;
  isActive?: boolean;
}

interface CEOChatPanelProps {
  taskId: string;
  agentId: string;
  agentName: string;
  companyId: string;
  companyName?: string;
  companyGoal?: string;
  conversations?: ChatConversation[];
  onSwitchConversation?: (taskId: string) => void;
  onNewConversation?: () => void;
  onPlanDetected?: (planMarkdown: string) => void;
  onPlanApproved?: () => void;
  onAgentWorkingChange?: (working: boolean) => void;
  onOpenArtifact?: (key: string, title: string) => void;
}

/**
 * Clean agent message content — strip system init JSON, code blocks with
 * raw config/tool dumps, and other non-conversational output.
 */
function cleanAgentMessage(body: string): string {
  let cleaned = body;

  // Remove markdown links
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remove lines that look like raw JSON objects (system init, config dumps)
  cleaned = cleaned.replace(/^\s*\{["\w].*["\w]\}\s*$/gm, "");

  // Remove code blocks containing JSON or system data
  cleaned = cleaned.replace(/```(?:json|plaintext|text)?\s*\n?\{[\s\S]*?\}\s*\n?```/g, "");

  // Remove lines that are clearly system output (tool lists, session IDs, etc.)
  cleaned = cleaned.replace(/^.*"(?:type|subtype|session_id|tools|mcp_servers|model|permissionMode|slash_commands|agents)".*$/gm, "");

  // Remove excessive blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}

/**
 * Check if a streaming chunk looks like system/init output rather than
 * conversational text. Used to filter relay streaming.
 */
function isSystemChunk(text: string): boolean {
  // JSON-like content
  if (/^\s*\{/.test(text) && /"type"\s*:/.test(text)) return true;
  // Tool/permission dumps
  if (/"tools"\s*:\s*\[/.test(text)) return true;
  if (/"mcp_servers"\s*:\s*\[/.test(text)) return true;
  if (/"session_id"\s*:/.test(text)) return true;
  return false;
}


/** Animated paperclip SVG thinking indicator */
function PaperclipThinking({ className }: { className?: string }) {
  return (
    <img
      src="/paperclip-thinking.svg"
      alt=""
      className={cn("inline-block", className)}
      style={{ width: 17, height: 17 }}
    />
  );
}



const QUEUED_MESSAGES = [
  "Heartbeat triggered, waking up...",
  "Initializing...",
  "Getting ready...",
];

const RUNNING_MESSAGES = [
  "Working on a response...",
  "Reading the conversation...",
  "Thinking through the plan...",
  "Drafting a response...",
  "Still working...",
  "Almost there...",
];

const WAITING_MESSAGES = [
  "Waiting to wake up...",
  "Heartbeat pending...",
  "Should wake up soon...",
];

function getCyclingMessage(messages: string[], elapsed: number, agentName: string): string {
  const idx = Math.floor(elapsed / 5) % messages.length;
  return `${agentName} · ${messages[idx]}`;
}

function getRunStatusMessage(status: string, agentName: string, elapsed: number): string {
  switch (status) {
    case "queued":
      return getCyclingMessage(QUEUED_MESSAGES, elapsed, agentName);
    case "running":
      return getCyclingMessage(RUNNING_MESSAGES, elapsed, agentName);
    case "succeeded":
      return `${agentName} finished`;
    case "failed":
      return `${agentName} encountered an error`;
    case "cancelled":
      return `${agentName}'s run was cancelled`;
    case "timed_out":
      return `${agentName}'s run timed out`;
    default:
      return `${agentName} is thinking...`;
  }
}

/** Stepped progress indicator for long waits */
function getProgressStep(elapsed: number): string | null {
  if (elapsed < 10) return null;
  if (elapsed < 30) return "Analyzing your mission...";
  if (elapsed < 60) return "Drafting the plan...";
  if (elapsed < 90) return "Detailing roles and responsibilities...";
  return "Almost ready...";
}

/** Context-aware suggestion chips — label IS the message */
function getSuggestionChips(
  hasActiveRun: boolean,
  hasPlanDetected: boolean,
  hasComments: boolean,
): string[] {
  if (hasPlanDetected) {
    return [
      "I want to make changes",
      "Add another role",
    ];
  }
  if (hasActiveRun) {
    return [
      "What can I do while waiting?",
      "Tell me about team structure",
    ];
  }
  if (hasComments) {
    return [
      "What should we prioritize?",
      "Create a new project",
    ];
  }
  return [
    "Let's talk strategy",
    "What do you need from me?",
  ];
}

export function CEOChatPanel({
  taskId,
  agentId,
  agentName,
  companyId,
  companyName,
  companyGoal,
  conversations,
  onSwitchConversation,
  onNewConversation,
  onPlanDetected,
  onPlanApproved,
  onAgentWorkingChange,
  onOpenArtifact,
}: CEOChatPanelProps) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [detectedPlanCommentId, setDetectedPlanCommentId] = useState<string | null>(null);
  const [ignoreBeforeCommentId, setIgnoreBeforeCommentId] = useState<string | null>(null);
  const [usePaperclipIndicator, setUsePaperclipIndicator] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSearch, setDrawerSearch] = useState("");
  // Welcome typing animation — phases: typing → message
  const [welcomePhase, setWelcomePhase] = useState<"typing" | "message">("typing");
  // Optimistic typing indicator — shows immediately after user sends
  const [optimisticTyping, setOptimisticTyping] = useState(false);
  // Optimistic user message — shown instantly before server confirms
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Track whether we've already created a draft artifact in the current send cycle
  const draftCreatedRef = useRef(false);

  // Poll comments — faster when waiting for a response
  const { data: rawComments, isLoading } = useQuery({
    queryKey: queryKeys.issues.comments(taskId),
    queryFn: () => issuesApi.listComments(taskId),
    refetchInterval: optimisticTyping ? 2000 : 4000,
  });

  // Heartbeat polling disabled — the stream endpoint handles chat directly.
  const activeRun = null as any;

  const comments = useMemo(
    () =>
      rawComments
        ? [...rawComments].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          )
        : undefined,
    [rawComments],
  );

  // Welcome message — show typing indicator, then persist as agent comment
  const welcomeSavedRef = useRef(false);
  useEffect(() => {
    if (comments && comments.length === 0 && welcomePhase === "typing" && !welcomeSavedRef.current) {
      welcomeSavedRef.current = true;
      // Build the welcome text
      let welcomeText = `Hello! I'm **${agentName}**${companyName ? `, your CEO at **${companyName}**` : ", your CEO"}.`;
      if (companyGoal) {
        welcomeText += `\n\nOur mission: *${companyGoal}*`;
      }
      welcomeText += `\n\nI'd love to understand your vision and priorities before we start building the team. What's most important to you right now?`;

      // Save as agent comment after a brief typing delay
      const timer = setTimeout(() => {
        fetch(`/api/agents/${agentId}/chat/canned`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId, message: welcomeText }),
        }).then(() => {
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(taskId) });
          setWelcomePhase("message");
        }).catch(() => {
          setWelcomePhase("message");
        });
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [comments, welcomePhase, agentId, agentName, companyName, companyGoal, taskId, queryClient]);


  // Clear optimistic typing when a NEW agent comment arrives (not the welcome)
  const commentCountAtSendRef = useRef(0);
  useEffect(() => {
    if (optimisticTyping && comments?.length) {
      // Only clear if a new agent comment appeared since we started sending
      if (comments.length > commentCountAtSendRef.current) {
        const newComments = comments.slice(commentCountAtSendRef.current);
        if (newComments.some((c) => c.authorAgentId)) {
          setOptimisticTyping(false);
        }
      }
    }
  }, [comments, optimisticTyping]);

  // Clear optimistic message once it appears in the real comment list
  useEffect(() => {
    if (optimisticMessage && comments?.length) {
      const hasUserMsg = comments.some((c) => c.authorUserId && c.body === optimisticMessage);
      if (hasUserMsg) setOptimisticMessage(null);
    }
  }, [comments, optimisticMessage]);

  // Detect hiring plan
  // Plan detection removed — handled by server-side observer pattern in /chat/stream

  // Streaming response state
  // Streaming: buffer holds all received text, visible is what's shown (typewriter)
  const [streamingText, setStreamingText] = useState("");
  const streamingBufferRef = useRef("");
  const streamingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Typewriter effect — progressively reveal streaming buffer
  useEffect(() => {
    if (streamingBufferRef.current.length > streamingText.length) {
      if (!streamingTimerRef.current) {
        streamingTimerRef.current = setInterval(() => {
          setStreamingText((prev) => {
            const buf = streamingBufferRef.current;
            if (prev.length >= buf.length) {
              if (streamingTimerRef.current) clearInterval(streamingTimerRef.current);
              streamingTimerRef.current = null;
              return prev;
            }
            // Reveal 2-4 chars per tick for natural typing feel
            const step = Math.floor(Math.random() * 3) + 2;
            return buf.slice(0, Math.min(prev.length + step, buf.length));
          });
        }, 12);
      }
    }
  }, [streamingText]);

  // Auto-scroll on new comments or streaming text
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [comments?.length, streamingText]);

  // Send message — try streaming relay first, fall back to poll-based
  const sendMessage = useCallback(async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setInput("");
    setOptimisticMessage(trimmed);
    setOptimisticTyping(true);
    commentCountAtSendRef.current = comments?.length ?? 0;
    draftCreatedRef.current = false;

    const latestId = comments?.[comments.length - 1]?.id ?? null;
    setIgnoreBeforeCommentId(latestId);
    setDetectedPlanCommentId(null);

    try {
      // Try lightweight streaming endpoint (longer timeout — CLI needs startup time)
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(`/api/agents/${agentId}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, message: trimmed }),
        signal: controller.signal,
      });
      clearTimeout(fetchTimeout);

      if (!res.ok || !res.body) {
        throw new Error("Relay not available");
      }

      setStreamingText("");
      streamingBufferRef.current = "";
      if (streamingTimerRef.current) { clearInterval(streamingTimerRef.current); streamingTimerRef.current = null; }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "chunk" && !isSystemChunk(event.text)) {
              // Clear typing indicator on first real chunk
              setOptimisticTyping(false);
              // Add to buffer — typewriter effect will reveal progressively
              streamingBufferRef.current += event.text;
              // Kick the typewriter if it hasn't started
              setStreamingText((prev) => prev || streamingBufferRef.current.slice(0, 1));
            } else if (event.type === "done") {
              // Flush remaining buffer instantly
              setStreamingText(streamingBufferRef.current);
              if (streamingTimerRef.current) clearInterval(streamingTimerRef.current);
              streamingTimerRef.current = null;
              // Refresh comments to pick up persisted messages
              queryClient.invalidateQueries({
                queryKey: queryKeys.issues.comments(taskId),
              });
            } else if (event.type === "observer" && event.actions) {
              // Observer agent detected artifacts or tasks to create
              const actions = event.actions as {
                artifacts?: Array<{ title: string; status: string }>;
                tasks?: Array<{ title: string; description: string }>;
              };
              // Build conversation context for artifact generation
              const convoContext = comments?.map((c) => {
                const role = c.authorAgentId ? "CEO" : "USER";
                return `${role}: ${c.body}`;
              }).join("\n\n") ?? "";

              for (const artifact of actions.artifacts ?? []) {
                issuesApi.createWorkProduct(taskId, {
                  type: "document",
                  title: artifact.title,
                  provider: "paperclip",
                  status: "draft",
                  reviewState: "none",
                  isPrimary: true,
                  summary: `${agentName} is working on ${artifact.title}...`,
                }).then((wp) => {
                  queryClient.invalidateQueries({ queryKey: queryKeys.issues.workProducts(taskId) });
                  // Trigger background document generation
                  fetch(`/api/agents/${agentId}/chat/generate-artifact`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      taskId,
                      artifactTitle: artifact.title,
                      workProductId: (wp as any).id,
                      conversationContext: convoContext,
                    }),
                  }).catch(() => {});
                }).catch(() => {});
                // Assign task to CEO
                issuesApi.update(taskId, { assigneeAgentId: agentId, status: "in_progress" }).catch(() => {});
              }
              for (const task of actions.tasks ?? []) {
                issuesApi.create(companyId, {
                  title: task.title,
                  description: task.description,
                  assigneeAgentId: agentId,
                  status: "todo",
                }).then(() => {
                  queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
                }).catch(() => {});
              }
            } else if (event.type === "error") {
              setStreamingText("");
              streamingBufferRef.current = "";
              if (streamingTimerRef.current) { clearInterval(streamingTimerRef.current); streamingTimerRef.current = null; }
            }
          } catch { /* malformed SSE line, skip */ }
        }
      }

      // Wait briefly for typewriter to finish, then clear
      setTimeout(() => {
        setStreamingText("");
        streamingBufferRef.current = "";
        if (streamingTimerRef.current) { clearInterval(streamingTimerRef.current); streamingTimerRef.current = null; }
      }, 500);
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.comments(taskId),
      });
    } catch {
      // Stream endpoint failed or timed out — message was already saved server-side,
      // so just refresh comments and let polling pick up any response
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.comments(taskId),
      });
    } finally {
      setSending(false);
      setOptimisticTyping(false);
      inputRef.current?.focus();
    }
  }, [sending, taskId, agentId, companyId, agentName, queryClient, comments]);

  const handleSend = useCallback(() => {
    sendMessage(input);
  }, [input, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Status indicators
  const lastComment = comments?.[comments.length - 1];
  const isWaitingForAgent = lastComment && lastComment.authorUserId && !lastComment.authorAgentId;
  const hasActiveRun = activeRun && (activeRun.status === "queued" || activeRun.status === "running");
  const showStatus = isWaitingForAgent || hasActiveRun;

  // Notify parent of working state changes
  useEffect(() => {
    onAgentWorkingChange?.(!!showStatus);
  }, [showStatus, onAgentWorkingChange]);

  // Elapsed timer
  const [elapsed, setElapsed] = useState(0);
  const waitingSince = useMemo(() => {
    if (!showStatus || !lastComment) return null;
    if (lastComment.authorUserId) return new Date(lastComment.createdAt).getTime();
    if (hasActiveRun && activeRun.createdAt) return new Date(activeRun.createdAt).getTime();
    return null;
  }, [showStatus, lastComment, hasActiveRun, activeRun]);

  useEffect(() => {
    if (!waitingSince) { setElapsed(0); return; }
    setElapsed(Math.floor((Date.now() - waitingSince) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - waitingSince) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [waitingSince]);

  const elapsedStr = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : `${elapsed}s`;

  const progressStep = getProgressStep(elapsed);
  const suggestionChips = getSuggestionChips(!!hasActiveRun, false, !!comments?.length);

  // Dynamic placeholder
  const placeholder = hasActiveRun
    ? `${agentName} is working...`
    : "Send a message...";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Loading conversation...
      </div>
    );
  }

  const filteredConversations = (conversations ?? []).filter((c) =>
    !drawerSearch || c.title.toLowerCase().includes(drawerSearch.toLowerCase()),
  );

  return (
    <div className="flex flex-col h-full relative">
      {/* Chat header */}
      <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
        <button
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
          onClick={() => setDrawerOpen(true)}
          title="Chat history"
        >
          <History className="h-4 w-4" />
        </button>
        <span className="text-[13px] font-medium flex-1 truncate">{agentName}</span>
      </div>

      {/* Chat history drawer — slides over chat */}
      {drawerOpen && (
        <div className="absolute inset-0 z-20 bg-background flex flex-col animate-in slide-in-from-left duration-200">
          <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
            <button
              className="text-muted-foreground hover:text-foreground p-1 rounded"
              onClick={() => { setDrawerOpen(false); setDrawerSearch(""); }}
            >
              <X className="h-4 w-4" />
            </button>
            <span className="text-[13px] font-medium flex-1">Conversations</span>
            {onNewConversation && (
              <button
                className="text-muted-foreground hover:text-foreground p-1 rounded"
                onClick={onNewConversation}
                title="New conversation"
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="px-3 py-2 border-b border-border">
            <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/50"
                placeholder="Search conversations..."
                value={drawerSearch}
                onChange={(e) => setDrawerSearch(e.target.value)}
                autoFocus
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-auto-hide">
            {filteredConversations.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                {conversations?.length === 0 ? "No conversations yet" : "No matches"}
              </div>
            ) : (
              filteredConversations.map((conv) => (
                <button
                  key={conv.id}
                  className={cn(
                    "w-full text-left px-3 py-2.5 border-b border-border hover:bg-accent/30 transition-colors",
                    conv.isActive && "bg-accent/50",
                  )}
                  onClick={() => {
                    onSwitchConversation?.(conv.id);
                    setDrawerOpen(false);
                    setDrawerSearch("");
                  }}
                >
                  <p className="text-[13px] font-medium truncate">{conv.title}</p>
                  {conv.lastMessage && (
                    <p className="text-[11px] text-muted-foreground truncate mt-0.5">{conv.lastMessage}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                    {new Date(conv.updatedAt).toLocaleDateString()}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>
      )}


      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scrollbar-auto-hide space-y-2.5 p-4"
      >
        {/* CEO Welcome — typing indicator until welcome comment is saved and loaded */}
        {comments !== undefined && comments.length === 0 && welcomePhase === "typing" && (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground px-3 py-2">
            {usePaperclipIndicator ? (
              <PaperclipThinking />
            ) : (
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500" />
              </span>
            )}
            {agentName} is composing a message...
          </div>
        )}

        {comments?.map((comment) => {
          const isAgent = Boolean(comment.authorAgentId);
          // Hide comments that are entirely system output
          const displayBody = isAgent ? cleanAgentMessage(comment.body) : comment.body;
          if (isAgent && !displayBody) return null;
          return (
            <div key={comment.id}>
              <div
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-[13px] leading-relaxed",
                  isAgent
                    ? "bg-muted/50 border border-border mr-6"
                    : "bg-accent/50 border border-accent ml-6",
                )}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span
                    className={cn(
                      "text-[10px] font-medium uppercase tracking-wide",
                      isAgent ? "text-muted-foreground" : "text-foreground/70",
                    )}
                  >
                    {isAgent ? agentName : "You"}
                  </span>
                </div>
                <div className="prose prose-xs dark:prose-invert max-w-none text-[13px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                  <MarkdownBody>{displayBody}</MarkdownBody>
                </div>
              </div>

            </div>
          );
        })}

        {/* Streaming response — shows text as it arrives */}
        {streamingText && (
          <div className="rounded-md px-2.5 py-1.5 text-[13px] leading-relaxed bg-muted/50 border border-border mr-6 animate-in fade-in duration-150">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {agentName}
              </span>
            </div>
            <div className="prose prose-xs dark:prose-invert max-w-none text-[13px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <MarkdownBody>{streamingText}</MarkdownBody>
            </div>
          </div>
        )}

        {/* Optimistic user message — shows instantly before server confirms */}
        {optimisticMessage && (
          <div className="rounded-md px-2.5 py-1.5 text-[13px] leading-relaxed bg-accent/50 border border-accent ml-6">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-foreground/70">
                You
              </span>
            </div>
            <div className="prose prose-xs dark:prose-invert max-w-none text-[13px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <MarkdownBody>{optimisticMessage}</MarkdownBody>
            </div>
          </div>
        )}

        {/* Optimistic typing indicator — shows immediately after user sends */}
        {optimisticTyping && (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground px-3 py-1.5">
            {usePaperclipIndicator ? (
              <PaperclipThinking />
            ) : (
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500" />
              </span>
            )}
            {agentName} is typing...
          </div>
        )}
      </div>

      {/* Suggestion chips — hide after 4 messages */}
      {(comments?.length ?? 0) < 4 && <div className="px-3 pb-1.5 flex flex-wrap gap-1">
        {suggestionChips.map((chip) => (
          <button
            key={chip}
            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            onClick={() => { setInput(chip); inputRef.current?.focus(); }}
          >
            {chip}
          </button>
        ))}
      </div>}

      {/* Input area */}
      <div className="flex items-center gap-1.5 px-3 pb-3 pt-1.5 border-t border-border">
        <input
          ref={inputRef}
          type="text"
          className="flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <Button
          size="sm"
          disabled={!input.trim() || sending}
          onClick={handleSend}
          className="shrink-0"
        >
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

