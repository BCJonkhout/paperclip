import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { goalsApi } from "../api/goals";
import { queryKeys } from "../lib/queryKeys";
import { CEOChatPanel, type ChatConversation } from "../components/CEOChatPanel";
import { ArtifactsPanel } from "../components/ArtifactsPanel";
import { Loader2 } from "lucide-react";

export function Chat() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Chat" }]);
  }, [setBreadcrumbs]);

  const [searchParams] = useSearchParams();
  const taskIdParam = searchParams.get("taskId");
  const [agentWorking, setAgentWorking] = useState(false);
  const [openDocKey, setOpenDocKey] = useState<string | null>(null);
  const [openDocTitle, setOpenDocTitle] = useState<string | null>(null);

  // Resizable chat pane
  const [chatWidth, setChatWidth] = useState(360);
  const dragging = useRef(false);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startWidth = chatWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const newWidth = Math.min(600, Math.max(280, startWidth + ev.clientX - startX));
      setChatWidth(newWidth);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [chatWidth]);

  const handleAgentWorkingChange = useCallback((working: boolean) => {
    setAgentWorking(working);
  }, []);

  const handleOpenArtifact = useCallback((key: string, title: string) => {
    setOpenDocKey(key);
    setOpenDocTitle(title);
  }, []);

  const handleClearOpenDoc = useCallback(() => {
    setOpenDocKey(null);
    setOpenDocTitle(null);
  }, []);

  // Find CEO agent
  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const ceoAgent = useMemo(
    () => agents?.find((a) => a.role === "ceo" && a.status !== "terminated"),
    [agents],
  );

  const navigate = useNavigate();

  // Fetch all issues for the conversation list + task finding
  const { data: allIssues, isLoading: issuesLoading } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Only use subset for task finding when no param
  const issues = !taskIdParam ? allIssues : undefined;

  // Get company goal for the greeting
  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const companyGoal = useMemo(() => {
    const goal = goals?.find((g) => g.level === "company");
    return goal?.title ?? "";
  }, [goals]);

  const taskId = useMemo(() => {
    if (taskIdParam) return taskIdParam;
    // Find a planning/chat task by title, or fall back to any CEO-assigned task
    const planningTask = issues?.find(
      (i) =>
        i.title.toLowerCase().includes("hiring plan") ||
        i.title.toLowerCase().includes("build hiring plan") ||
        i.title.toLowerCase().includes("plan ai agents") ||
        i.title.toLowerCase().includes("chat with ceo"),
    );
    if (planningTask) return planningTask.id;
    // Fall back: any task assigned to the CEO agent
    const ceoTask = ceoAgent && issues?.find((i) => i.assigneeAgentId === ceoAgent.id);
    return ceoTask?.id ?? null;
  }, [taskIdParam, issues, ceoAgent]);

  // Build conversations list from CEO-assigned issues
  const conversations: ChatConversation[] = useMemo(() => {
    if (!allIssues || !ceoAgent) return [];
    return allIssues
      .filter((i) => i.assigneeAgentId === ceoAgent.id || i.id === taskId)
      .map((i) => ({
        id: i.id,
        title: i.title,
        updatedAt: String(i.updatedAt ?? i.createdAt),
        isActive: i.id === taskId,
      }))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [allIssues, ceoAgent, taskId]);

  const handleSwitchConversation = useCallback((newTaskId: string) => {
    const prefix = selectedCompany?.issuePrefix;
    if (prefix) {
      navigate(`/${prefix}/chat?taskId=${newTaskId}`);
    }
  }, [selectedCompany, navigate]);

  // Approve: update work product status + create hire tasks
  const handleApprove = useCallback(async () => {
    if (!taskId || !selectedCompanyId || !ceoAgent) return;
    try {
      // Update work product to approved
      const wps = await issuesApi.listWorkProducts(taskId);
      const planWp = wps.find((wp) => wp.title === "Hiring Plan");
      if (planWp) {
        await issuesApi.updateWorkProduct(planWp.id, {
          status: "approved",
          reviewState: "approved",
          summary: "Hiring plan approved by the board",
        });
      }

      // Parse plan and create hire tasks
      let planMarkdown = "";
      try {
        const doc = await issuesApi.getDocument(taskId, "plan");
        planMarkdown = doc.body ?? "";
      } catch { /* fallback */ }

      // Parse plan and create hire tasks
      const roles = planMarkdown ? parseRolesFromPlan(planMarkdown) : [];
      for (const role of roles) {
        try {
          await issuesApi.create(selectedCompanyId, {
            title: `Hire: ${role.name}`,
            description: `Hire a ${role.name} for the company.\n\n${role.spec}`,
            assigneeAgentId: ceoAgent.id,
            status: "todo",
          });
        } catch { /* skip failed task creation */ }
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });

      // Confirmation in chat
      try {
        await issuesApi.addComment(taskId, `Plan approved! ${roles.length} hire task${roles.length === 1 ? "" : "s"} created.`);
      } catch { /* non-critical */ }
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(taskId) });

      // Trigger CEO to respond immediately via stream endpoint
      fetch(`/api/agents/${ceoAgent.id}/chat/canned`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          message: `Great news! The plan has been approved. I've created ${roles.length} hire task${roles.length === 1 ? "" : "s"} and I'll start working on them right away. You can track progress in the Tasks view.`,
        }),
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(taskId) });
      }).catch(() => {});

      queryClient.invalidateQueries({ queryKey: queryKeys.issues.workProducts(taskId) });
    } catch (err) {
      console.error("Approve failed:", err);
    }
  }, [taskId, selectedCompanyId, ceoAgent, queryClient]);

  // Reject: update work product to changes_requested, tell CEO to revise
  const handleReject = useCallback(async () => {
    if (!taskId || !ceoAgent) return;
    try {
      // Update existing work product status — don't create a new one
      const wps = await issuesApi.listWorkProducts(taskId);
      const planWp = wps.find((wp) => wp.title === "Hiring Plan");
      if (planWp) {
        await issuesApi.updateWorkProduct(planWp.id, {
          status: "changes_requested",
          reviewState: "changes_requested",
          summary: "Board requested changes to the hiring plan",
        });
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.issues.workProducts(taskId) });

      // Tell CEO to revise via chat comment
      await issuesApi.addComment(
        taskId,
        "I'd like you to revise the hiring plan. Please update the existing plan document with changes.",
        true, true,
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(taskId) });
    } catch { /* non-critical */ }
  }, [taskId, ceoAgent, queryClient]);

  const isLoading = agentsLoading || issuesLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Loading...
      </div>
    );
  }

  if (!ceoAgent) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-sm">
          <h2 className="text-lg font-semibold">No CEO agent found</h2>
          <p className="text-sm text-muted-foreground mt-2">
            Create a company with a CEO agent through onboarding to use the chat.
          </p>
        </div>
      </div>
    );
  }

  if (!taskId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-sm">
          <h2 className="text-lg font-semibold">No planning task found</h2>
          <p className="text-sm text-muted-foreground mt-2">
            Start a conversation with your CEO by creating a planning task.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100%+3rem)] -m-6">
      {/* Left: Chat */}
      <div className="shrink-0 border-r border-border" style={{ width: chatWidth }}>
        <CEOChatPanel
          taskId={taskId}
          agentId={ceoAgent.id}
          agentName={ceoAgent.name}
          companyId={selectedCompanyId!}
          companyName={selectedCompany?.name}
          companyGoal={companyGoal}
          conversations={conversations}
          onSwitchConversation={handleSwitchConversation}
          onAgentWorkingChange={handleAgentWorkingChange}
          onOpenArtifact={handleOpenArtifact}
        />
      </div>

      {/* Drag handle */}
      <div
        className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-foreground/20 transition-colors"
        onMouseDown={handleDragStart}
      />

      {/* Right: Artifacts */}
      <div className="flex-1 min-w-0 hidden lg:block">
        <ArtifactsPanel
          taskId={taskId}
          isAgentWorking={agentWorking}
          openDocKey={openDocKey}
          openDocTitle={openDocTitle}
          onClearOpenDoc={handleClearOpenDoc}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      </div>
    </div>
  );
}

/**
 * Minimal parser to extract role names and specs from a hiring plan markdown.
 */
function parseRolesFromPlan(markdown: string): Array<{ name: string; spec: string }> {
  const roles: Array<{ name: string; spec: string }> = [];
  const seen = new Set<string>();

  const rolePattern = /^(?:role\s*\d+[:.]\s*|\d+[.)]\s*)/i;
  const roleHeadingRegex = /^#{2,3}\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  const positions: Array<{ title: string; start: number; contentStart: number }> = [];
  while ((match = roleHeadingRegex.exec(markdown)) !== null) {
    if (rolePattern.test(match[1].trim())) {
      positions.push({
        title: match[1].trim(),
        start: match.index,
        contentStart: match.index + match[0].length,
      });
    }
  }

  for (let i = 0; i < positions.length; i++) {
    const end = i + 1 < positions.length ? positions[i + 1].start : markdown.length;
    const body = markdown.slice(positions[i].contentStart, end).trim();

    let name = positions[i].title
      .replace(/^role\s*\d*[:.]\s*/i, "")
      .replace(/^\d+[.)]\s*/, "")
      .replace(/\*\*/g, "")
      .trim();

    if (name.length < 3 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    roles.push({ name, spec: body });
  }

  // Fallback: numbered bold roles
  if (roles.length === 0) {
    const lines = markdown.split("\n");
    let currentName = "";
    let currentSpec: string[] = [];

    for (const line of lines) {
      const roleMatch = line.match(/^\s*(\d+)[.)]\s+\*\*([^*]+)\*\*/);
      if (roleMatch) {
        if (currentName && !seen.has(currentName.toLowerCase())) {
          seen.add(currentName.toLowerCase());
          roles.push({ name: currentName, spec: currentSpec.join("\n") });
        }
        currentName = roleMatch[2].trim();
        currentSpec = [];
        continue;
      }
      if (currentName && line.trim()) {
        currentSpec.push(line.trim());
      }
    }
    if (currentName && !seen.has(currentName.toLowerCase())) {
      roles.push({ name: currentName, spec: currentSpec.join("\n") });
    }
  }

  return roles;
}
