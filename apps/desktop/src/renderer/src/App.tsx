import { AttachmentChooser, AttachmentPreview } from "./chat-attachments.js";
import { SkillsPanel } from "./skills-panel.js";
import { AutomationPanel } from "./automation-panel.js";
import { commandError } from "./app/command-error.js";
import { Row } from "./app/conversation-row.js";
import { Identity } from "./app/identity.js";
import { HomeBody } from "./app/home-body.js";
import { useSplitLayout } from "./app/use-split-layout.js";
import { useThreadList } from "./app/use-thread-list.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { UIMessage } from "ai";
import type {
  AppInfo,
  MainToRenderer,
  UiSnapshot,
  UiState,
} from "../../shared/ui-contract.js";
import {
  withSteerRecords,
  overlayShellProgress,
  overlayExecutionReceipts,
  canReuseReceiptHistory,
  rowsFromHistory,
  annotateHistoryTools,
  annotateMemoryReceipts,
  type ConversationRow,
} from "./conversation.js";
import { homeView as toHomeView } from "./home-view.js";
import type { HomeSnapshot } from "@serika/assistant/browser";
import { MemoryPanel } from "./memory.js";
import { MemoryConsolidationNotice } from "./memory-consolidation.js";
import { ThreadsPanel } from "./threads.js";
import { MemoryReferences } from "./memory-references.js";
import { ContextPanel } from "./context.js";
import { RecordsPanel } from "./records.js";
import { useRunRecords } from "./app/use-run-records.js";
import { steerReview, UncertainSteerNotice } from "./app/steers.js";
import { usePrimaryRun } from "./app/primary-run.js";
import { useChatAttachments } from "./app/use-chat-attachments.js";
import { useConversationDraftPersistence, useConversationDraftState } from "./app/use-conversation-draft.js";
import { useBriefContinue } from "./app/use-brief-continue.js";
import { ApprovalCard } from "./approval.js";
import { useApproval } from "./app/use-approval.js";
import { shouldSubmitComposer, canSubmitComposer, canSteerComposer } from "../../shared/composer.js";
import { steerFailureLabel } from "../../shared/steer.js";
import { Icon, SerikaMark, SerikaPersona } from "./icons.js";
import { MessageContent } from "./markdown.js";
import { CapabilitiesPanel } from "./capabilities.js";
import { TelegramPanel } from "./telegram-panel.js";
import { PomodoroPanel } from "./pomodoro.js";
import { attentionKind, headerStatus, deliveredReplyKeys, isMockModel } from "./attention.js";
import { CurrentTask, useWorkTasks, WorkTasksPanel } from "./work-tasks.js";
import { RssPanel } from "./rss.js";
import { TaskInbox } from "./task-inbox.js";
import { SavedTaskNotice } from "./saved-task-notice.js";
import { createTaskNoticeDismissals } from "../../shared/saved-task-result.js";
import { unreconciledRuns, taskSelectionKey, taskActions } from "./work-task-data.js";
import { bindTaskComposer, draftKey, type ConversationDraft } from "./navigation.js";
import { MemorySetup } from "./daily-setup-panel.js";
import { desktopLayout, type DesktopLayout } from "./zcode/layout.js";
import { PersonalConversation as ZCodeConversation, PersonalBackToBottom as ZCodeBackToBottom } from "./personal/conversation.js";
import { PersonalPromptEditor as ZCodePromptEditor, PersonalPromptOptions as ZCodePromptOptions } from "./personal/composer.js";
import { TodayPanel } from "./personal/today.js";
import { TasksHome } from "./personal/tasks-page.js";
import { nextComposerText, nextTaskInstruction, type TaskComposerHandoff } from "./personal/tasks-model.js";
import { useTodayBriefFeeds } from "./personal/today-feeds.js";
import { writeBriefContinue, type BriefContinueTarget } from "./personal/today-continue.js";
import { createAndStartTask } from "./create-task.js";
import { SearchOverlay } from "./personal/search-overlay.js";
import { SettingsAbout, SettingsFrame, SettingsGeneral, SettingsHome, SettingsNotifications, SettingsShortcuts } from "./personal/settings.js";
import { isConnectorModule, settingsRouteForInitial, type SettingsListTarget, type SettingsRoute } from "./personal/settings-model.js";
import { clampChatFraction, dashboardTabForDetail } from "./personal/layout.js";
import { humanFacingTitle } from "../../shared/human-title.js";
import { RemindersPanel } from "./reminders.js";
import { DesktopWindowFrame } from "./zcode/upstream/desktop-window-frame.js";
import { Button } from "./zcode/upstream/button.js";
import { ArrowUp, Square, Search, Settings2 } from "lucide-react";
import { draftScope } from "../../shared/conversation-drafts.js";
import { ErrorBanner } from "./failure-notice.js";
import "./zcode/theme.css";
import "./personal/shell.css";
import "./personal/today.css";
import "./personal/tasks.css";
import "./personal/memory.css";
import "./personal/settings.css";
import "./personal/conversation.css";

const OUTPUT_MAX_CHARS = 64 * 1024;

export function App({ initialLayout }: { initialLayout?: DesktopLayout } = {}) {
  const layout = initialLayout ?? desktopLayout(window.location.search);
  const [identityGeneration, setIdentityGeneration] = useState(0);
  const [initialSettings, setInitialSettings] = useState<false | "modules" | "context">(false);
  const [initialSettingsError, setInitialSettingsError] = useState<string | null>(null);
  const drafts = useRef(new Map<string, ConversationDraft>());
  const [appearance, setAppearance] = useState<"dark" | "light">(() => localStorage.getItem("serika:personal-appearance") === "dark" ? "dark" : "light");
  const toggleAppearance = () => setAppearance(value => {
    const next = value === "dark" ? "light" : "dark";
    localStorage.setItem("serika:personal-appearance", next);
    return next;
  });
  useEffect(() => window.runloom.onMessage(message => {
    if (message.type === "identity-changed") { setInitialSettings(message.reason ?? false); setInitialSettingsError(message.configurationError ?? null); setIdentityGeneration(value => value + 1); }
  }), []);
  // Reset evidence/previews on identity changes; drafts also recover from main-process storage.
  const page = <AssistantPage key={identityGeneration} drafts={drafts.current} layout={layout} initialSettings={initialSettings} initialSettingsError={initialSettingsError} appearance={appearance} onAppearance={toggleAppearance} />;
  return <div className={`serika-personal-shell personal-theme-${appearance}`}><DesktopWindowFrame title="Serika" isDesktop={true} isMacDesktop={document.documentElement.dataset.nativeWindowControls === "macos"}>{page}</DesktopWindowFrame></div>;
}

function AssistantPage({ drafts, layout, initialSettings = false, initialSettingsError = null, appearance, onAppearance }: { drafts: Map<string, ConversationDraft>; layout: DesktopLayout; initialSettings?: false | "modules" | "context"; initialSettingsError?: string | null; appearance: "dark" | "light"; onAppearance: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [mobileDashboard, setMobileDashboard] = useState(!!initialSettings);
  const { windowWidth, sidebarOpen, splitRoot, compact, dashboardOpen, actualFraction, saveSplit, rememberSidebar } = useSplitLayout(mobileDashboard);
  const [taskResultFocus, setTaskResultFocus] = useState<{ taskId: string; workspaceRoot: string; sequence: number } | null>(null);
  const [state, setState] = useState<UiState>({ kind: "idle" });
  const [homeSnapshot, setHomeSnapshot] = useState<HomeSnapshot | null>(null);
  const [output, setOutput] = useState("");
  const [storedHistory, setStoredHistory] = useState<{ rows: ConversationRow[]; runId: string | null }>({ rows: [], runId: null });
  const history = storedHistory.rows;
  const historyMessages = useRef<UIMessage[]>([]);
  const [historyBefore, setHistoryBefore] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const conversationDraft = useConversationDraftState();
  const { draftReady, setDraftReady, draftError, setDraftError, draftSaving, draftSave, input, setInput, excludeFromMemory, setExcludeFromMemory } = conversationDraft;
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { approval, setApproval, decidingId, decide } = useApproval(setMobileDashboard, setError);
  const { live, lastResult, canSteer, setCanSteer, finalRecord, latestPrimaryId, latestCompletedPrimaryId, shellBuffer, steers, replaceSteers, mergeSteer, uncertainSteer, setUncertainSteer,
    applyRunSnapshot, loadFinalRun, onRunState, onRunSteer, onRunEvent, isCurrentPrimaryResult, finishPrimaryRun, onRunShellProgress } = usePrimaryRun(setError);
  const [submittedInput, setSubmittedInput] = useState<string | null>(null);
  const { attachments, setAttachments, sentAttachments, recoverableAttachments, setRecoverableAttachments, settleSentAttachments } = useChatAttachments(info, setError);
  const [showOutput, setShowOutput] = useState(false);
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [contextRefresh, setContextRefresh] = useState(0);
  const [taskRefresh, setTaskRefresh] = useState(0);
  const [automationRefresh, setAutomationRefresh] = useState(0);
  const [creatingTask, setCreatingTask] = useState(false);
  const [createTaskRequest, setCreateTaskRequest] = useState(0);
  const [taskDraft, setTaskDraft] = useState("");
  const [taskFocused, setTaskFocused] = useState(false);
  const [switchingThread, setSwitchingThread] = useState(false);
  const threadSwitchInFlight = useRef(false);
  const historyRequest = useRef(0);
  const [detailsOpen, setDetailsOpen] = useState(!!initialSettings);
  const [detailTab, setDetailTab] = useState<"threads" | "tasks" | "reminders" | "home" | "records" | "memory" | "context" | "pomodoro" | "modules" | "settings">(initialSettings ? "settings" : "home");
  const [settingsRoute, setSettingsRoute] = useState<SettingsRoute>(settingsRouteForInitial(initialSettings));
  const [searchOpen, setSearchOpen] = useState(false);
  const briefFeeds = useTodayBriefFeeds(info?.workspaceRoot != null, automationRefresh, info?.workspaceRoot);
  const [sending, setSending] = useState(false);
  const sendInFlight = useRef(false);
  const conversationEnd = useRef<HTMLDivElement | null>(null);
  const conversationScroll = useRef<HTMLDivElement | null>(null);
  const inspectorScroll = useRef<HTMLDivElement | null>(null);
  const inspectorPositions = useRef(new Map<string, number>());
  const followConversation = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [unreadOutput, setUnreadOutput] = useState(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const { records, recordDetail, traceFocusTool, loadRecords, reloadOpen: reloadOpenRecords, openRecord, closeRecord, refreshOpenTrace, invalidate: invalidateRecords } = useRunRecords(detailsOpen && detailTab === "records", setError);
  const taskRunStarted = useCallback((text: string) => { setSubmittedInput(text); followConversation.current = true; setDetailsOpen(false); setMobileDashboard(false); }, []);
  const workTasks = useWorkTasks(info?.workTasks === true, state.kind !== "idle", taskRefresh, taskRunStarted, taskSelectionKey(info), info ? draftScope(info) : null);
  const { composerTaskId: taskComposerId, setComposerTaskId: setTaskComposerId } = workTasks;
  const composerBinding = bindTaskComposer(taskComposerId, workTasks.task);
  const composingTask = composerBinding.kind === "task";
  const composerTask = composerBinding.kind === "task" ? composerBinding.task : null;
  const composerText = composingTask ? composerTask ? workTasks.instruction : "" : input;
  const composerFinishedRun = useRef<string | null>(null);
  useEffect(() => {
    if (!lastResult || composerFinishedRun.current === lastResult.key) return;
    composerFinishedRun.current = lastResult.key;
    if (taskComposerId) setTaskComposerId(null);
  }, [lastResult, taskComposerId, setTaskComposerId]);
  const inspectorKey = detailTab === "tasks" ? `tasks:${workTasks.task?.id ?? "none"}:${taskFocused}` : detailTab === "settings" ? `settings:${settingsRoute}` : detailTab;
  useLayoutEffect(() => {
    if (detailsOpen && inspectorScroll.current) inspectorScroll.current.scrollTop = inspectorPositions.current.get(inspectorKey) ?? 0;
  }, [detailsOpen, inspectorKey]);

  const applySnapshot = useCallback((snapshot: UiSnapshot) => {
    setState(snapshot.state);
    setApproval(snapshot.pendingApproval);
    setOutput(snapshot.recentOutput);
    applyRunSnapshot(snapshot);
  }, [applyRunSnapshot]);

  const reloadHistory = useCallback(async () => {
    const request = ++historyRequest.current;
    const primaryId = latestPrimaryId.current;
    const completedId = latestCompletedPrimaryId.current;
    const [page, receipts, identity] = await Promise.all([window.runloom.historyPage(), window.runloom.listRuns().catch(() => null), window.runloom.info()]);
    if (request !== historyRequest.current || primaryId !== latestPrimaryId.current || completedId !== latestCompletedPrimaryId.current) return;
    if (page.threadId !== identity.threadId) return;
    if (page.memoryReceiptError) setError(page.memoryReceiptError);
    const messages = page.messages;
    historyMessages.current = messages;
    setHistoryBefore(page.beforeId);
    // Only a reread made after this primary Run completed can supply its full
    // outcomes. Provider tool IDs are not unique across the whole Thread.
    const rows = receipts?.ok ? annotateHistoryTools(rowsFromHistory(messages), receipts.runs, identity.threadId) : rowsFromHistory(messages);
    const withMemory = annotateMemoryReceipts(rows, page.memoryReceipts ?? [], identity.threadId);
    setStoredHistory({ rows: completedId === null ? withMemory : overlayShellProgress(withMemory, shellBuffer.current), runId: completedId });
  }, []);

  const loadOlderHistory = async () => {
    if (!historyBefore || historyLoading) return;
    const request = ++historyRequest.current;
    setHistoryLoading(true);
    const area = conversationScroll.current, height = area?.scrollHeight ?? 0, top = area?.scrollTop ?? 0;
    try {
      const [page, identity, receipts] = await Promise.all([window.runloom.historyPage({ beforeId: historyBefore }), window.runloom.info(), window.runloom.listRuns().catch(() => null)]);
      if (request !== historyRequest.current || page.threadId !== identity.threadId) return;
      if (page.memoryReceiptError) setError(page.memoryReceiptError);
      const messages = [...page.messages, ...historyMessages.current];
      historyMessages.current = messages; setHistoryBefore(page.beforeId);
      const rows = receipts?.ok ? annotateHistoryTools(rowsFromHistory(messages), receipts.runs, identity.threadId) : rowsFromHistory(messages);
      followConversation.current = false;
      setStoredHistory(current => ({ ...current, rows: annotateMemoryReceipts(rows, page.memoryReceipts ?? [], identity.threadId) }));
      requestAnimationFrame(() => { if (area) area.scrollTop = top + area.scrollHeight - height; });
    } catch { setError("更早的对话读取失败；当前内容仍保留，可以重试"); }
    finally { setHistoryLoading(false); }
  };

  useEffect(() => {
    let cancelled = false;
    let stop = (): void => undefined;
    const openNotificationResult = async () => {
      const route = await window.runloom.takeTaskResultOpen?.();
      if (!route || cancelled) return;
      setTaskResultFocus(previous => ({ ...route, sequence: (previous?.sequence ?? 0) + 1 }));
      setDetailTab("reminders"); setDetailsOpen(true); setMobileDashboard(true);
    };

    const onMessage = (message: MainToRenderer): void => {
      switch (message.type) {
        case "task-result-available":
          void openNotificationResult().catch(cause => { if (!cancelled) setError(String(cause)); });
          return;
        case "identity-changed":
          return; // The outer App remounts this view for the new controller.
        case "state":
          setState(message.state);
          if (onRunState(message.state, () => cancelled)) historyRequest.current += 1;
          if (message.state.kind === "idle") {
            setMemoryRefresh(value => value + 1);
            setContextRefresh((value) => value + 1);
            setTaskRefresh((value) => value + 1);
            void reloadHistory().catch((cause: unknown) => setError(String(cause)));
            void reloadOpenRecords().catch((cause: unknown) => setError(String(cause)));
          }
          return;
        case "output":
          setOutput((previous) => (previous + message.text).slice(-OUTPUT_MAX_CHARS));
          return;
        case "home":
          setHomeSnapshot(message.snapshot);
          return;
        case "module-notification":
          // Shown by the main process; its text is also in the output log.
          return;
        case "approval":
          setApproval(message.approval);
          refreshOpenTrace();
          return;
        case "approval-cleared":
          setApproval((current) => (current?.approvalId === message.approvalId ? null : current));
          return;
        case "steer":
          onRunSteer(message.steer);
          return;
        case "event":
          if (message.event.type !== "message.delta" && message.event.type !== "usage.updated") refreshOpenTrace();
          onRunEvent(message);
          return;
        case "result":
          setContextRefresh((value) => value + 1);
          if (!isCurrentPrimaryResult(message)) return;
          setCanSteer(false);
          settleSentAttachments(message.result);
          finishPrimaryRun(message.result);
          return;
        case "memory-references-changed":
          setContextRefresh(value => value + 1);
          return;
        case "shell-progress":
          onRunShellProgress(message);
          return;
        case "memory-updated":
          setMemoryRefresh((value) => value + 1);
          void reloadHistory().catch((cause: unknown) => setError(String(cause)));
          return;
        case "work-task-updated":
          setTaskRefresh((value) => value + 1);
          return;
        case "error":
          setError(message.message);
          return;
        default: {
          const exhaustive: never = message;
          return exhaustive;
        }
      }
    };

    void (async () => {
      try {
        stop = window.runloom.onMessage(onMessage);
        const nextInfo = await window.runloom.info();
        if (cancelled) return;
        setInfo(nextInfo);
        try {
          const saved = await window.runloom.loadConversationDraft(draftScope(nextInfo));
          if (cancelled) return;
          drafts.set(draftKey(nextInfo), saved.draft);
          setInput(saved.draft.text || (!saved.uncertainSteer?.taskId ? saved.uncertainSteer?.text : "") || "");
          setExcludeFromMemory(saved.draft.excludeFromMemory);
          setCreatingTask(saved.draft.createTask === true);
          setUncertainSteer(saved.uncertainSteer);
          setDraftReady(true);
          if (saved.draft.createTask) requestAnimationFrame(() => inputRef.current?.focus());
        } catch {
          if (cancelled) return;
          const cached = drafts.get(draftKey(nextInfo));
          setInput(cached?.text ?? "");
          setDraftError("保存的草稿无法读取，未覆盖原文件。修复保存位置后重新加载；当前不会发送。");
        }
        if (nextInfo.runtimeRecovery) { setError(nextInfo.runtimeRecovery.message); return; }
        await openNotificationResult();
        const first = await window.runloom.snapshot();
        if (cancelled) return;
        applySnapshot(first);
        const second = await window.runloom.snapshot();
        if (cancelled) return;
        applySnapshot(second);
        if (second.lastPrimaryResult && !(second.state.kind === "running" && second.state.phase === "primary")) {
          await loadFinalRun(second.lastPrimaryResult.runId);
        }
        await reloadHistory();
        // History waits for receipt recovery; only now is the restart Steer state authoritative.
        const recovered = await window.runloom.snapshot();
        if (cancelled) return;
        replaceSteers(recovered.steers);
        setCanSteer(recovered.canSteer);
        await loadRecords();
        const homeResult = await window.runloom.home();
        if (!homeResult.ok && homeResult.reason !== "busy" && !cancelled) setError(commandError(homeResult));
      } catch (cause: unknown) {
        if (!cancelled) setError(String(cause));
      }
    })();

    return () => {
      cancelled = true;
      historyRequest.current += 1;
      invalidateRecords();
      stop();
    };
  }, [applySnapshot, reloadHistory, loadRecords, loadFinalRun, drafts, refreshOpenTrace, invalidateRecords, replaceSteers, onRunState, onRunSteer, onRunEvent, isCurrentPrimaryResult, finishPrimaryRun, onRunShellProgress, settleSentAttachments]);

  useEffect(() => {
    if (detailsOpen && detailTab === "records") void reloadOpenRecords().catch(() => setError("执行追踪读取失败"));
  }, [detailsOpen, detailTab, reloadOpenRecords]);

  useConversationDraftPersistence(conversationDraft, info, drafts, creatingTask);

  const { briefHold, setBriefNonce } = useBriefContinue({ info, draftReady, workTasks, uncertainSteer, setError, setDetailsOpen, setMobileDashboard, setTaskComposerId, setInput, inputRef });

  useEffect(() => {
    if (!detailsOpen && !mobileDashboard) return;
    const close = (event: KeyboardEvent) => {
      // Let an inner disclosure/dialog consume Escape first.
      if (searchOpen) return;
      if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented) {
        if (detailTab === "settings" && settingsRoute !== "home") { setSettingsRoute("home"); event.preventDefault(); return; }
        setDetailsOpen(false); setMobileDashboard(false); event.preventDefault();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [detailsOpen, mobileDashboard, searchOpen, detailTab, settingsRoute]);

  const { conversationTitle, threads, refreshThreads } = useThreadList(info, state.kind);

  useLayoutEffect(() => {
    const area = conversationScroll.current;
    if (!area) return;
    if (followConversation.current) { area.scrollTop = area.scrollHeight; setUnreadOutput(false); setAwayFromLatest(false); }
    else setUnreadOutput(true);
  }, [history, live, lastResult, submittedInput, approval, detailsOpen, composerText]);

  useLayoutEffect(() => {
    const area = conversationScroll.current;
    if (!area) return;
    // Window/composer resizing must keep the latest message anchored, but must
    // not pull someone away from the history they deliberately scrolled to.
    const observer = new ResizeObserver(() => {
      if (followConversation.current && area.clientHeight > 0) area.scrollTop = area.scrollHeight;
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(open => !open);
        return;
      }
      if (searchOpen) return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (detailTab === "settings" && settingsRoute !== "home") { setSettingsRoute("home"); return; }
        if (detailsOpen || mobileDashboard) { setDetailsOpen(false); setMobileDashboard(false); }
        else void window.runloom.hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsOpen, mobileDashboard, searchOpen, detailTab, settingsRoute]);

  const submit = useCallback(async () => {
    const line = composerText.trim();
    if ((!composingTask && line.length === 0 && !attachments.length) || sendInFlight.current || threadSwitchInFlight.current) return;
    setError(null);
    if (!info || !draftReady || draftError || info.runtimeRecovery) { setError("请先恢复连接和草稿保存，再发送。"); return; }
    if (uncertainSteer !== null) { setError("上次补充的接收结果未知，请先核对；不会重复发送。"); return; }
    if (attachments.length && (composingTask || creatingTask || line.startsWith("/") || (state.kind !== "idle" && !(state.kind === "running" && state.background)))) { setError("请先以普通消息发送附件，再创建任务或补充要求。"); return; }
    if (canSteerComposer(state, canSteer)) {
      if (line.length === 0) return;
      if (line.startsWith("/")) { setError("运行中只接收补充要求，命令请等本轮结束再执行。草稿已保留。"); return; }
      const request = { expectedRunId: state.runId, id: crypto.randomUUID(), text: line, scope: draftScope(info), ...(composingTask && composerTask ? { taskId: composerTask.id } : {}) };
      sendInFlight.current = true;
      setSending(true);
      let invokedSteer = false;
      try {
        await draftSave.current;
        if (composingTask) await workTasks.flushDrafts();
        invokedSteer = true;
        const response = await window.runloom.steer(request);
        if (!response.ok) {
          if (response.reason === "failed") {
            setUncertainSteer({ id: request.id, runId: request.expectedRunId, text: line, ...(request.taskId ? { taskId: request.taskId } : {}) });
            setError("补充要求的持久接收凭证尚未确认。请核对状态；草稿保留，不会自动重发。");
          } else if (response.reason === "storage") {
            setError("草稿存储不可用，补充未发送。请恢复保存位置后重试。");
          } else if (response.reason === "unresolved") {
            const saved = await window.runloom.loadConversationDraft(draftScope(info));
            setUncertainSteer(saved.uncertainSteer);
            setError("上一条补充仍待核对，不会发送新补充。");
          } else setError(steerFailureLabel(response.reason));
          return;
        }
        mergeSteer(response.steer);
        const receipt = await window.runloom.acknowledgeSteer(draftScope(info), request.id);
        if (!receipt) throw new Error("接收凭证尚未确认");
        if (receipt.status !== "not_applied") {
          if (request.taskId) workTasks.clearInstruction(request.taskId, line);
          else setInput(current => current.trim() === line ? "" : current);
        }
      } catch {
        if (!invokedSteer) { setDraftError("草稿未保存，补充未发送。请先重试保存。"); return; }
        // An IPC failure is not proof that the controller did not accept it.
        setUncertainSteer({ id: request.id, runId: request.expectedRunId, text: line, ...(request.taskId ? { taskId: request.taskId } : {}) });
        setError("补充要求的接收结果未收到。请核对状态；草稿保留，不会自动重发。");
      } finally { sendInFlight.current = false; setSending(false); }
      return;
    }
    if (approval !== null) {
      setError("请先处理上方确认");
      return;
    }
    if (!canSubmitComposer(state, composingTask ? "task" : line.startsWith("/") ? "command" : "chat")) { setError("当前忙，输入未排队"); return; }
    sendInFlight.current = true;
    setSending(true);
    try {
      await draftSave.current;
      if (composingTask) {
        if (!composerTask || !taskActions(composerTask).run || workTasks.locked) {
          setError("当前任务不能开始下一轮，请先核对任务状态。"); return;
        }
        await workTasks.run(line);
        return;
      }
      if (creatingTask) {
        await workTasks.flushDrafts();
        const result = await createAndStartTask(window.runloom, window.localStorage, draftScope(info), line, id => {
          setCreatingTask(false); setInput(""); setTaskComposerId(id); workTasks.select(id);
        });
        workTasks.reread();
        if (result.kind === "started") setSubmittedInput(line);
        else setError(result.kind === "saved" ? "任务已创建，尚未开始。请从任务中核对后显式开始。" : result.kind === "start_unknown" ? "任务已创建，启动结果未知。请查看执行记录，不会自动重试。" : result.message ?? "创建失败，请核对任务记录。");
        return;
      }
      if (line.startsWith("/")) {
        const response = await window.runloom.command(line);
        if (!response.ok) { setError(commandError(response)); return; }
        setInput("");
        return;
      }
      sentAttachments.current = attachments.length ? { runId: null, files: attachments, text: line } : null;
      setRecoverableAttachments(null);
      const response = await window.runloom.run(line, { ...(excludeFromMemory ? { memoryConsolidation: "exclude" as const } : {}), ...(attachments.length ? { attachments } : {}) });
      if (!response.ok) {
        setError(response.reason === "empty" ? "输入为空" : response.reason === "busy" ? "本条消息未接收、未排队；请在当前处理结束后重发。草稿已保留。" : "未能开始处理，草稿和附件已保留。请核对错误后重试。");
        return;
      }
      if (sentAttachments.current) sentAttachments.current.runId = response.runId;
      setSubmittedInput(line || "请查看附件。");
      setInput("");
      setAttachments([]);
      setExcludeFromMemory(false);
    } catch { setError(creatingTask ? "任务保存或启动结果未确认。请查看任务列表核对，不会自动重试。" : "未收到启动结果。请核对当前状态，不会自动重发。"); }
    finally { sendInFlight.current = false; setSending(false); }
  }, [attachments, composerText, composingTask, composerTask, creatingTask, workTasks, approval, state, excludeFromMemory, canSteer, uncertainSteer, info, draftReady, draftError]);

  const busy = state.kind !== "idle";
  const steering = canSteerComposer(state, canSteer);
  const composerReady = draftReady && draftError === null && (!composingTask || (workTasks.draftReady && !workTasks.draftError)) && !info?.runtimeRecovery && uncertainSteer === null && (steering || canSubmitComposer(state, composingTask ? "task" : composerText.trim().startsWith("/") ? "command" : "chat"));
  const running = state.kind === "running";
  const activePrimary = running && state.phase === "primary";
  const { recheckSteer, releaseSteer } = steerReview({ info, busy, uncertainSteer, setUncertainSteer, mergeSteer, workTasks, setInput, setTaskComposerId, setError, draftSave });
  const retryConnection = async () => {
    if (reconnecting) return;
    setReconnecting(true);
    try { await window.runloom.retryConnection(); }
    catch { setError("连接恢复失败。请修正配置后重试；不会重放之前的任务。"); }
    finally { setReconnecting(false); }
  };
  const visibleRows: ConversationRow[] = withSteerRecords([...history, ...(activePrimary ? [
    ...(submittedInput ? [{ kind: "text" as const, key: "submitted-input", role: "user" as const, text: submittedInput, committed: false }] : []),
    ...live.rows,
  ] : [])], steers);
  const rows = [...(!activePrimary && finalRecord ? overlayExecutionReceipts(visibleRows, finalRecord.tools, { reuseHistory: canReuseReceiptHistory(finalRecord, storedHistory.runId), runId: finalRecord.runId }) : visibleRows),
    ...(!activePrimary && lastResult ? [lastResult] : [])];
  const delivered = deliveredReplyKeys(rows);
  const homeView = toHomeView(homeSnapshot);
  const unknownRuns = records.status === "ready" ? unreconciledRuns(records.runs, workTasks.tasks) : [];
  const reviewTask = workTasks.tasks.find(task => task.status === "needs_review");
  const openDetails = (tab: typeof detailTab) => {
    setDetailTab(tab); setDetailsOpen(true); setMobileDashboard(true);
    if (!compact) rememberSidebar(true);
  };
  const openSettings = (route: SettingsListTarget) => {
    if (route === "records") { openDetails("records"); return; }
    setSettingsRoute(route);
    openDetails("settings");
  };
  const backSettings = () => {
    if (settingsRoute === "home") { setDetailsOpen(false); setMobileDashboard(false); return; }
    setSettingsRoute("home");
  };
  const toggleSidebar = () => {
    if (compact) { setMobileDashboard(value => !value); return; }
    rememberSidebar(!sidebarOpen);
  };
  const applyTaskHandoff = (handoff: TaskComposerHandoff) => {
    if (!info || sending || switchingThread) return;
    if (uncertainSteer) { setError("还有一条补充没核对完，草稿先不动。"); return; }
    if (handoff.mode === "task" && handoff.taskId) {
      workTasks.select(handoff.taskId);
      setTaskComposerId(handoff.taskId);
      if (workTasks.task?.id === handoff.taskId) {
        const next = nextTaskInstruction(workTasks.instruction, handoff);
        if (next !== null) workTasks.setInstruction(next);
      }
    } else {
      setTaskComposerId(null);
      setInput(current => nextComposerText(current, handoff));
    }
    if (compact) setMobileDashboard(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const openCreateTask = async (text = "") => {
    if (!info?.workTasks || busy || sending || threadSwitchInFlight.current) return;
    threadSwitchInFlight.current = true; setSwitchingThread(true);
    try {
      await draftSave.current; await workTasks.flushDrafts();
      await window.runloom.createThread({ preserveDraft: true, taskDraft: text });
      setDetailsOpen(false); setMobileDashboard(false);
    } catch { setError("创建任务的对话未打开，请核对当前对话；草稿保留，不会自动重试。"); }
    finally { threadSwitchInFlight.current = false; setSwitchingThread(false); }
  };
  const openMemory = () => { openDetails("memory"); };
  const openTask = () => { setTaskFocused(true); openDetails("tasks"); };
  const composeTask = () => {
    if (!workTasks.task || !taskActions(workTasks.task).run || workTasks.locked) return;
    setTaskComposerId(workTasks.task.id); setDetailsOpen(false); setMobileDashboard(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const attention = attentionKind({ approval: approval !== null, unknownRuns: unknownRuns.length || (reviewTask ? 1 : 0), pendingMemory: 0, idle: !busy });
  const status = headerStatus(state, attention);
  const stageLabel = info?.runtimeRecovery ? "连接已停止" : info ? status.label : error ? "连接失败" : "正在连接";
  const threadDrafts = new Map(threads.flatMap(thread => {
    const draft = drafts.get(draftKey({ workspaceRoot: info?.workspaceRoot ?? null, directory: thread.transcriptDirectory, threadId: thread.threadId }));
    return draft?.text ? [[thread.threadId, draft.text] as const] : [];
  }));
  const pageTitle = !detailsOpen ? conversationTitle : ({ threads: "全部对话", tasks: "任务", reminders: "提醒", home: "工作区", records: "执行记录", memory: "记忆", context: "上下文与压缩", pomodoro: "番茄钟", modules: "模块能力", settings: "设置" })[detailTab];
  const pageDescription = ({ threads: "继续之前的对话，或开始一段新对话。", tasks: "把需要执行和验收的事放在这里；普通聊天不用创建任务。", reminders: "查看已经设好的提醒，以及刚刚触发的结果。", home: "查看保存的进度、订阅和当前配置。提醒列表在「提醒」。", records: "核对每次执行的工具结果，区分完成、失败和未知效果。", memory: "已经记住的偏好、项目和工作。", context: "长对话由系统自动管理，通常不需要你操作。", pomodoro: "专注计时，直接操作，不必发消息。", modules: "决定助手可以使用哪些能力。", settings: "外观、偏好和应用信息" })[detailTab];
  const newConversation = async (chatDraft?: string) => {
    if (busy || sending || threadSwitchInFlight.current || !info) return;
    threadSwitchInFlight.current = true;
    setSwitchingThread(true);
    try {
      await draftSave.current;
      await workTasks.flushDrafts();
      if (input.length) drafts.set(draftKey(info), { text: input, excludeFromMemory, ...(creatingTask ? { createTask: true as const } : {}) });
      await window.runloom.createThread({ preserveDraft: input.length > 0, ...(chatDraft !== undefined ? { chatDraft } : {}) });
      setDetailsOpen(false); setMobileDashboard(false);
    }
    catch { setError("新对话未打开，请查看当前会话；不会自动重试。"); }
    finally { threadSwitchInFlight.current = false; setSwitchingThread(false); }
  };
  const selectConversation = async (id: string) => {
    if (busy || sending || threadSwitchInFlight.current || !info) return;
    if (id === info.threadId) { setDetailsOpen(false); setMobileDashboard(false); return; }
    threadSwitchInFlight.current = true;
    setSwitchingThread(true);
    try { await draftSave.current; await workTasks.flushDrafts(); await window.runloom.selectThread(id); }
    catch { setError("对话切换未确认，请核对当前会话；不会自动重试。"); }
    finally { threadSwitchInFlight.current = false; setSwitchingThread(false); }
  };
  const prepareInput = (text: string) => { setInput(text); inputRef.current?.focus(); };
  const continueBrief = (target: BriefContinueTarget) => {
    if (!info || sending || switchingThread) return;
    if (target.threadId !== info.threadId && (busy || threadSwitchInFlight.current)) return;
    briefHold.current = target;
    try { writeBriefContinue(sessionStorage, target); } catch { /* The in-memory hold still applies in this page. */ }
    if (target.threadId !== info.threadId) { void selectConversation(target.threadId); return; }
    setBriefNonce(value => value + 1);
  };
  const scrollToLatest = () => {
    followConversation.current = true;
    if (conversationScroll.current) conversationScroll.current.scrollTop = conversationScroll.current.scrollHeight;
    setUnreadOutput(false);
  };
  const restoreSteer = (text: string) => {
    setTaskComposerId(null);
    setInput(current => current ? `${current}\n${text}` : text);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div ref={splitRoot} className={`app personal-layout${compact ? " is-compact" : ""}${compact && mobileDashboard ? " show-dashboard" : ""}${!compact && !sidebarOpen ? " sidebar-collapsed" : ""}`} style={{ "--chat-fraction": actualFraction } as CSSProperties}>
      <div className="main-shell">
        <header className="header">
          <span className="personal-name"><SerikaPersona size={52} /></span>
          <span className="personal-conversation-title">{conversationTitle}</span>
          <span className={`run-state ${status.tone}`} role="status"><span className={`state-dot ${status.tone}`} />{stageLabel}</span>
          <span className="spacer" />
          <button className="personal-mobile-today" type="button" onClick={() => setMobileDashboard(true)}>手札<Icon name="chevron" size={14} /></button>
          {info?.workTasks && !creatingTask && !(detailsOpen && detailTab === "tasks") ? <button className="personal-create-task" type="button" disabled={busy || sending || switchingThread} title={busy ? "本轮结束后可创建新任务" : "在新对话中创建任务"} onClick={() => void openCreateTask()}><Icon name="new-chat" size={15} />创建任务</button> : null}
          {!dashboardOpen ? <button className="personal-sidebar-toggle" type="button" aria-label="搜索" title="搜索" onClick={() => setSearchOpen(true)}><Search size={16} /></button> : null}
          <button className="personal-sidebar-toggle" type="button" aria-pressed={dashboardOpen} aria-label={dashboardOpen ? "收起侧栏" : "展开侧栏"} title={dashboardOpen ? "收起侧栏，对话占满窗口" : "展开侧栏"} onClick={toggleSidebar}><Icon name="panel" size={16} /></button>
          <button className="icon-button personal-new-chat" type="button" aria-label="新对话" title="新对话；保留当前草稿" disabled={busy || sending || switchingThread || !info} onClick={() => void newConversation()}><Icon name="new-chat" /></button>
        </header>
        {isMockModel(info?.modelAlias) || info?.entryMode === "test" ? <div className="model-mode-notice" role="status">{info?.entryMode === "test" ? "隔离测试 · 会话和记忆不属于日用工作区。" : ""}{isMockModel(info?.modelAlias) ? "模拟模型，不会调用真实模型。" : ""}</div> : null}
        {info ? <SavedTaskNotice key={`${info.configPath}:${info.workspaceRoot}`} enabled={!!info.workspaceRoot} workspaceRoot={info.workspaceRoot ?? ""} refreshSequence={automationRefresh} onDismiss={() => setAutomationRefresh(value => value + 1)} onOpen={taskId => {
          const workspaceRoot = info.workspaceRoot;
          if (!workspaceRoot) return;
          setTaskResultFocus(previous => ({ taskId, workspaceRoot, sequence: (previous?.sequence ?? 0) + 1 }));
          openDetails("reminders");
        }} /> : null}
        {info && attention === "none" ? <MemoryConsolidationNotice key={`${info.workspaceRoot}:${info.threadId}`} enabled={info.memory.enabled} busy={busy} quiet={true} running={state.kind === "running" && state.phase === "consolidation"} refreshToken={memoryRefresh} onOpen={() => openMemory()} /> : null}
        <div className="attention-region" hidden={attention === "none"}>
          {attention === "unknown" ? <div className="review-notice execution-review" role="status"><Icon name="shield" size={16} /><span>执行效果待核对 · 不会自动重做</span><button className="ghost" onClick={() => { if (reviewTask) { workTasks.select(reviewTask.id); openTask(); } else { openDetails("records"); const run = unknownRuns[0]; if (run) void openRecord(run.runId); } }}>{reviewTask ? "核对工作任务" : "查看回执"}<Icon name="chevron" size={14} /></button></div> : null}
          {attention === "approval" && unknownRuns.length > 0 ? <div className="attention-summary"><button className="ghost" onClick={() => openDetails("records")}>另有执行效果待核对</button></div> : null}
        </div>
        <div className="workbench">
          <main className="workspace-pane">
            <section className="conversation" aria-label="对话">
              <CurrentTask view={workTasks} onOpen={openTask} onCompose={composeTask} compact={busy} />
              <div className="rows" ref={conversationScroll} onScroll={() => {
                const area = conversationScroll.current;
                if (!area) return;
                followConversation.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
                setAwayFromLatest(!followConversation.current);
                if (followConversation.current) setUnreadOutput(false);
              }}>
                {rows.length === 0 && !live.streaming && !workTasks.task ? <div className="conversation-empty">
                  <SerikaPersona size={72} />
                  <h1>你想完成什么？</h1>
                </div> : null}
                <div className="conversation-thread">
                  {historyBefore ? <button className="secondary" disabled={historyLoading} onClick={() => void loadOlderHistory()}>{historyLoading ? "正在读取…" : "查看更早的对话"}</button> : null}
                  {layout === "zcode" ? <ZCodeConversation rows={rows} onRestoreSteer={restoreSteer} workspaceRoot={info?.workspaceRoot ?? undefined} running={activePrimary} streaming={live.streaming} waitingForApproval={approval !== null} onTrace={(runId, toolCallId) => { openDetails("records"); void openRecord(runId, toolCallId).catch(() => setError("执行追踪读取失败")); }} /> : rows.map(row => <Row key={row.key} row={row} onRestoreSteer={restoreSteer} delivered={delivered.has(row.key)} />)}
                  {info?.memory.enabled ? <MemoryReferences hideEmpty={layout === "zcode"} refreshToken={contextRefresh} runId={state.kind === "running" && state.phase === "primary" ? state.runId : latestPrimaryId.current} starting={state.kind === "running" && state.phase === "primary" && state.runId === null} /> : null}
                  {layout !== "zcode" && activePrimary && live.streaming ? <div className="row row-text role-assistant live">
                    <span className="role"><SerikaMark size={20} /> Serika <span className="streaming-label">正在回复</span></span>
                    <MessageContent text={live.streaming} />
                  </div> : null}
                  {layout !== "zcode" && activePrimary && !live.streaming ? <div className="working-indicator" role="status"><span /><span /><span /><small>{approval ? "等待你的确认" : "正在处理"}</small></div> : null}
                  <div ref={conversationEnd} />
                </div>
              </div>
              {layout === "zcode" && awayFromLatest ? <ZCodeBackToBottom unread={unreadOutput} onClick={() => { scrollToLatest(); setAwayFromLatest(false); }} /> : layout !== "zcode" && unreadOutput ? <button className="latest-button" onClick={scrollToLatest}><Icon name="arrow" size={14} style={{ transform: "rotate(180deg)" }} />最新消息</button> : null}
              {showOutput ? <div className="system-output"><div><Icon name="terminal" size={16} /><span>系统输出 · 仅供诊断</span><button className="icon-button" aria-label="关闭系统输出" onClick={() => setShowOutput(false)}><Icon name="close" size={16} /></button></div><pre className="output">{output || "暂无输出"}</pre></div> : null}
            </section>
          </main>
        </div>
        <div className="action-dock">
          {info?.runtimeRecovery ? <div className="error error-banner" role="alert"><span>助手连接已停止：{info.runtimeRecovery.message}。修正配置后重新连接，不会重做旧任务。</span><button type="button" className="ghost" disabled={reconnecting} onClick={() => void retryConnection()}>{reconnecting ? "正在连接…" : "重新连接"}</button></div> : null}
          {draftError ? <div className="error error-banner" role="alert"><span>{draftError}</span><button type="button" className="ghost" onClick={() => {
            if (!info) return;
            if (!draftReady) { window.location.reload(); return; }
            const save = window.runloom.saveConversationDraft(draftScope(info), { text: input, excludeFromMemory, ...(creatingTask ? { createTask: true as const } : {}) });
            draftSave.current = save;
            void save.then(() => setDraftError(null)).catch(() => setDraftError("草稿仍未保存，内容保留，请检查保存位置。"));
          }}>重试保存</button></div> : null}
          {error ? info ? <ErrorBanner message={error} onClose={() => setError(null)} /> : <ErrorBanner message={error} /> : null}
          {workTasks.draftError ? <div className="error error-banner" role="alert"><span>{workTasks.draftError}</span><button className="ghost" type="button" onClick={workTasks.retryDrafts}>重试任务草稿保存</button></div> : null}
          {uncertainSteer ? <UncertainSteerNotice steer={uncertainSteer} busy={busy} onRecheck={() => void recheckSteer()} onRelease={() => void releaseSteer()} /> : null}
          {approval ? <ApprovalCard approval={approval} deciding={decidingId === approval.approvalId} onDecision={(decision, remember) => void decide(decision, remember === true)} /> : null}
          <ZCodePromptEditor inputRef={inputRef} value={composerText} aria-label={composingTask ? "本轮任务指令" : "消息输入"}
              notice={composingTask ? !composerTask ? "任务已切换，原草稿仍保留。重新选择任务，或切回普通对话。" : !busy && !taskActions(composerTask).run ? "本轮已结束，请从任务卡查看结果，或切回普通对话。" : null : null}
              topContent={<>{recoverableAttachments ? <div className="zcode-draft-setting"><span>上次未完成消息的附件仍可恢复。</span><button type="button" className="ghost" disabled={busy || sending || !!attachments.length || !!input.trim()} onClick={() => { setAttachments(recoverableAttachments.files); setInput(recoverableAttachments.text); setRecoverableAttachments(null); }}>恢复到草稿</button></div> : null}<AttachmentPreview attachments={attachments} setAttachments={setAttachments} disabled={sending} />{creatingTask ? <div className="composer-create-mode"><strong>新任务</strong><button type="button" className="ghost" disabled={busy || sending} onClick={() => setCreatingTask(false)}>返回普通对话</button></div> : null}{workTasks.task || composingTask ? <div className="composer-target" role="group" aria-label="发送方式"><button className={!composingTask ? "selected" : ""} type="button" aria-pressed={!composingTask} onClick={() => setTaskComposerId(null)}>普通对话</button><button className={composingTask ? "selected" : ""} type="button" aria-pressed={composingTask} disabled={!workTasks.task || (!taskActions(workTasks.task).run && !composingTask)} onClick={composeTask}>补充当前任务</button>{composingTask ? <span>{composerTask ? humanFacingTitle(composerTask.goal, "当前任务") : "当前任务暂不可用"}</span> : null}</div> : null}{excludeFromMemory && !composingTask ? <div className="zcode-draft-setting"><Icon name="memory" size={13} /><span>本条不存入记忆</span><button type="button" className="icon-button" aria-label="恢复本条记忆整理" onClick={() => setExcludeFromMemory(false)}><Icon name="close" size={12} /></button></div> : null}</>}
              disabled={sending || switchingThread || info === null || !draftReady || !!info.runtimeRecovery || (composingTask && !composerTask)}
              placeholder={creatingTask ? "想让 Serika 完成什么？" : composingTask && !composerTask ? "重新选择任务，或切回对话…" : approval && !steering ? "先确认上方操作，再发送…" : !composerReady ? "可以先写，结束后再发送…" : "和 Serika 聊天"}
              onChange={event => { if (!composingTask) setInput(event.target.value); else if (composerTask) workTasks.setInstruction(event.target.value); }}
              onKeyDown={event => {
                if (composerReady && shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) {
                  event.preventDefault(); followConversation.current = true; void submit();
                }
              }}
              leadingActions={<ZCodePromptOptions>
                <AttachmentChooser key={`${info?.workspaceRoot}:${info?.threadId}`} disabled={busy || sending || composingTask || creatingTask || info?.attachments !== true} onError={setError} onPicked={files => { if (files.length + attachments.length > 4 || [...attachments, ...files].reduce((sum, file) => sum + file.data.length * 3 / 4 - (file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0), 0) > 10 * 1024 * 1024) { setError("每条最多 4 个附件，总大小不超过 10 MiB"); return; } setAttachments(items => [...items, ...files]); }} />
                {info?.memory.enabled && !composingTask && !creatingTask ? <label className="memory-exclusion" title="这条消息不进入现在或以后的记忆候选整理；不会删除对话记录。已有记忆仍可通过关键词引用；本条不触发语义检索或画像引用。"><input type="checkbox" checked={excludeFromMemory} disabled={sending} onChange={event => setExcludeFromMemory(event.target.checked)} />本条不存入记忆</label> : null}
                {info?.workTasks && !composingTask && !creatingTask ? <button type="button" className="ghost" disabled={busy || workTasks.acting || sending} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setTaskDraft(input.trim()); setTaskFocused(true); openDetails("tasks"); setCreateTaskRequest(value => value + 1); }}><Icon name="activity" size={15} />{input.trim() ? "作为工作任务…" : "创建工作任务"}</button> : null}

              </ZCodePromptOptions>}
              submitControl={<>
                {!composingTask && input ? <span className="hint" role="status">{draftError ? "草稿未保存" : draftSaving ? "保存草稿…" : "草稿已保存"}</span> : null}
                {composingTask ? <span className="hint" role="status">{workTasks.draftError ? "任务草稿未保存" : workTasks.draftSaving ? "保存任务草稿…" : workTasks.draftReady ? "任务草稿已保存" : "正在恢复任务草稿…"}</span> : null}
                <span className="zcode-model-name" title="当前配置的模型；不代表本轮已联网验证">{info?.modelId ?? info?.modelAlias ?? "连接中"}</span>
                {busy ? <Button type="button" variant="outline" size="icon" className="zcode-stop-button" aria-label={state.kind === "compacting" ? "停止上下文压缩" : state.kind === "running" && state.phase === "consolidation" ? "停止记忆整理" : "停止本轮"} title={state.kind === "compacting" ? "停止上下文压缩" : state.kind === "running" && state.phase === "consolidation" ? "停止记忆整理" : "停止本轮；已执行的操作不会撤回"} onClick={() => void window.runloom.cancel().catch(() => setError("取消结果未收到，请核对当前状态。"))}><Square size={12} /></Button> : null}
                {composerReady ? <Button type="button" size={(creatingTask || composingTask) && !steering ? "default" : "icon"} className={`send-button${(creatingTask || composingTask) && !steering ? " task-send" : ""}`}
                  aria-label={creatingTask ? "创建并开始" : composingTask && !steering ? composerTask?.status === "ready" ? "开始任务" : "继续此任务" : "发送消息"}
                  title={steering ? "发送到当前这轮，等待正在执行的步骤结束后处理" : composingTask ? "显式开始下一次任务处理；工具仍需确认" : "发送（Enter）· 换行（Shift + Enter）"}
                  disabled={!composerReady || sending || switchingThread || !info || (steering ? !composerText.trim() : composingTask ? workTasks.locked || !composerTask || !taskActions(composerTask).run : !input.trim() && !attachments.length)}
                  onClick={() => { followConversation.current = true; void submit(); }}>
                  {creatingTask ? "创建并开始" : composingTask && !steering ? composerTask?.status === "ready" ? "开始任务" : "继续此任务" : <ArrowUp size={18} />}
                </Button> : null}
              </>}
          />
        </div>
      </div>
      <div className="personal-divider" role="separator" aria-label="调整对话栏宽度" aria-orientation="vertical"
        aria-valuemin={Math.round(clampChatFraction(windowWidth, 0.3) * 100)} aria-valuemax={Math.round(clampChatFraction(windowWidth, 0.7) * 100)} aria-valuenow={Math.round(actualFraction * 100)} tabIndex={compact || !sidebarOpen ? -1 : 0}
        onDoubleClick={() => saveSplit(0.5)}
        onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); saveSplit(actualFraction + (event.key === "ArrowLeft" ? -0.02 : 0.02)); } if (event.key === "Home") { event.preventDefault(); saveSplit(0.5); } }}
        onPointerDown={event => { if (!compact) event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const bounds = splitRoot.current?.getBoundingClientRect(); if (bounds) saveSplit((event.clientX - bounds.left) / (bounds.width - 6)); } }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
      <section className="personal-dashboard" aria-label="手札与个人助手">
        <header className="personal-dashboard-header">
          <button className="personal-mobile-back" type="button" onClick={() => setMobileDashboard(false)}><Icon name="chevron" size={14} style={{ transform: "rotate(180deg)" }} />对话</button>
          <nav className="personal-segments" aria-label="个人助手页面">
            {(["手札", "任务", "记忆"] as const).map(tab => <button type="button" key={tab}
              aria-current={(detailsOpen ? dashboardTabForDetail(detailTab) : "手札") === tab ? "page" : undefined}
              onClick={() => { if (tab === "手札") { setDetailsOpen(false); setMobileDashboard(true); } else if (tab === "任务") { setTaskFocused(false); openDetails("tasks"); } else openMemory(); }}>{tab}</button>)}
          </nav>
          <div className="personal-dashboard-actions">
            <button type="button" className="personal-circle" aria-label="搜索" title="搜索" aria-expanded={searchOpen} onClick={() => setSearchOpen(true)}><Search size={18} /></button>
            <button type="button" className="personal-circle" aria-label="设置" title="设置" aria-current={detailsOpen && dashboardTabForDetail(detailTab) === "设置" ? "page" : undefined} onClick={() => openSettings("home")}><Settings2 size={18} /></button>
          </div>
        </header>
        <div className="personal-today-scroll" hidden={detailsOpen}>
          <TodayPanel info={info} tasks={workTasks.tasks} tasksLoading={workTasks.loading} tasksError={workTasks.error}
            feeds={briefFeeds}
            continueDisabled={sending || switchingThread || info === null}
            onContinue={continueBrief}
            onBackgroundSettings={() => openSettings("notifications")}
            onPomodoro={() => openDetails("pomodoro")} onAutomation={() => openDetails("reminders")} />
        </div>
          <section className="inspector" hidden={!detailsOpen} aria-label={pageTitle}>
            {detailTab === "tasks" || detailTab === "settings" || detailTab === "memory" ? null : <div className="inspector-header"><div><h1>{pageTitle}</h1><p>{pageDescription}</p></div><button className="ghost" title="回到手札 · Escape" onClick={() => { setDetailsOpen(false); setMobileDashboard(false); }}><Icon name="close" size={16} />回到手札</button></div>}
            <div className="inspector-pane" ref={inspectorScroll} onScroll={() => { if (inspectorScroll.current) inspectorPositions.current.set(inspectorKey, inspectorScroll.current.scrollTop); }}>
              {detailTab === "threads" && info ? <ThreadsPanel info={info} drafts={threadDrafts} busy={busy || switchingThread} onSelect={selectConversation} onCreate={() => newConversation()} onChanged={refreshThreads} /> : null}
              <div hidden={detailTab !== "tasks"}>
                <TasksHome
                  tasksEnabled={info?.workTasks === true} tasks={workTasks.tasks} selected={workTasks.task} loading={workTasks.loading} error={workTasks.error}
                  busy={busy || sending || switchingThread || workTasks.acting} focused={taskFocused} workspaceReady={!!info?.workspaceRoot}
                  refreshToken={automationRefresh} identity={`${info?.configPath ?? ""}:${info?.workspaceRoot ?? ""}`} formRequest={createTaskRequest}
                  onSelect={workTasks.select} onCreate={handoff => { if (handoff.purpose === "arrangement") void newConversation(handoff.text); else if (handoff.mode === "chat") void openCreateTask(handoff.text); }} onContinue={applyTaskHandoff} onOpenSettings={() => openSettings("advanced")}
                  advancedForm={<WorkTasksPanel view={workTasks} createRequest={createTaskRequest} initialGoal={taskDraft} focused={false} onCompose={composeTask} onCreated={() => { setDetailsOpen(false); setMobileDashboard(false); setTaskFocused(true); }} onRun={runId => { openDetails("records"); void openRecord(runId).catch(() => setError("执行回执读取失败")); }} />}
                  advancedDetail={<WorkTasksPanel view={workTasks} focused={true} onCompose={composeTask} onRun={runId => { openDetails("records"); void openRecord(runId).catch(() => setError("执行回执读取失败")); }} />}
                />
              </div>
              <div hidden={detailTab !== "reminders"}>
                <RemindersPanel enabled={!!info?.workspaceRoot} busy={busy} identity={`${info?.configPath ?? ""}:${info?.workspaceRoot ?? ""}`} refreshSequence={automationRefresh} />
                {detailTab === "reminders" && info ? <details className="task-arrangements"><summary>管理定时安排与订阅</summary><div className="task-arrangements-body"><AutomationPanel busy={busy} identity={`${info.workspaceRoot}:${info.threadId}`} refreshSequence={automationRefresh} onRun={runId => { openDetails("records"); void openRecord(runId); }} /><RssPanel key={info.workspaceRoot ?? "no-workspace"} showInbox={false} enabled={!!info.workspaceRoot && info.modules?.some(module => module.id === "task" && module.enabled) === true} busy={busy} /></div></details> : null}
                <TaskInbox key={`${info?.configPath}:${info?.workspaceRoot}`} enabled={!!info?.workspaceRoot} canAcknowledge={info?.modules?.some(m => m.id === "task" && m.enabled) === true} busy={busy} onResultsRead={() => setAutomationRefresh(value => value + 1)} onResultOpened={task => {
                  if (info?.workspaceRoot) createTaskNoticeDismissals(window.localStorage, info.workspaceRoot).dismiss(task);
                }} focus={taskResultFocus?.workspaceRoot === info?.workspaceRoot ? taskResultFocus : null} />
              </div>
              <div hidden={detailTab !== "settings"}>
                <SettingsFrame route={settingsRoute} onBack={backSettings}>
                  {settingsRoute === "home" ? <SettingsHome info={info} busy={busy} onOpen={openSettings} /> : null}
                  {settingsRoute === "connectors" && info ? <CapabilitiesPanel info={{ ...info, modules: (info.modules ?? []).filter(module => isConnectorModule(module.id)) }} busy={busy} intro="连接外部服务，操作仍按原权限确认。" /> : null}
                  {settingsRoute === "files" && info ? <CapabilitiesPanel info={{ ...info, modules: (info.modules ?? []).filter(module => ["read-file", "web"].includes(module.id)) }} busy={busy} intro="访问工作区文件和公开网页；搜索、RSS 的配置状态单独显示。" /> : null}
                  {settingsRoute === "devices" && info ? <CapabilitiesPanel info={{ ...info, modules: (info.modules ?? []).filter(module => module.id === "computer") }} busy={busy} intro="只控制允许列表中的应用。驱动连接、系统权限与工具注册是不同状态。可在对话中请求 computer_check，经你批准后检查。" /> : null}
                  {settingsRoute === "skills" && info ? <SkillsPanel busy={busy} identity={`${info.workspaceRoot}:${info.threadId}`} refreshSequence={automationRefresh} onUseRecipe={text => void newConversation(text)} /> : null}
                  {settingsRoute === "channels" ? <TelegramPanel busy={busy} /> : null}
                  {settingsRoute === "memory" && info ? <><MemorySetup info={info} busy={busy} /><details className="card"><summary>管理记录</summary><MemoryPanel key={`management:${info.workspaceRoot}:${info.threadId}`} managementOnly memory={info.memory} temporaryThread={info.temporaryThread} threadId={info.threadId} controllerIdle={!busy} refreshToken={memoryRefresh} /></details><details className="card"><summary>高级配置与诊断</summary><CapabilitiesPanel info={{ ...info, modules: (info.modules ?? []).filter(module => module.id === "memory") }} busy={busy} /></details></> : null}
                  {settingsRoute === "advanced" && info ? <>
                    <div className="settings-group"><button className="settings-row" onClick={() => openSettings("context")}><span className="settings-row-copy"><strong>上下文与压缩</strong><small>查看长对话预算和压缩状态。</small></span></button><button className="settings-row" onClick={() => openSettings("records")}><span className="settings-row-copy"><strong>执行记录与用量</strong><small>核对工具回执、未知效果和模型调用。</small></span></button><button className="settings-row" onClick={() => openDetails("threads")}><span className="settings-row-copy"><strong>对话与历史</strong><small>查找、登记或恢复当前工作区的旧对话。</small></span></button></div>
                    <details className="card"><summary>命令与诊断</summary><div className="zcode-command-list">{info.commands.map(name => <button type="button" className="ghost" key={name} disabled={busy} onClick={() => prepareInput(`/${name} `)}>/{name}</button>)}</div><button type="button" className="ghost" onClick={() => setShowOutput(value => !value)}>{showOutput ? "隐藏系统输出" : "查看系统输出"}</button></details>
                    <details className="card"><summary>数据与配置位置</summary><Identity info={info} /><dl className="session-facts"><dt>配置</dt><dd>{info.configPath ?? "未指定"}</dd><dt>工作区</dt><dd>{info.workspaceRoot ?? "未配置"}</dd><dt>对话记录</dt><dd>{info.directory}</dd></dl></details>
                    {initialSettings === "modules" && initialSettingsError ? <p className="error" role="alert">未应用：{initialSettingsError}</p> : null}
                    <details className="card"><summary>已保存的项目进度</summary><button className="ghost" disabled={busy} onClick={() => void window.runloom.home().then(response => { if (!response.ok) setError(commandError(response)); }).catch(() => setError("概览读取失败"))}>刷新</button><HomeBody view={homeView} /></details>
                  </> : null}
                  {settingsRoute === "general" ? <SettingsGeneral appearance={appearance} busy={busy} onAppearance={onAppearance} /> : null}
                  {settingsRoute === "notifications" ? <SettingsNotifications enabled={info?.modules?.some(module => module.id === "task" && module.enabled) === true} busy={busy} /> : null}
                  {settingsRoute === "shortcuts" ? <SettingsShortcuts /> : null}
                  {settingsRoute === "about" && info ? <SettingsAbout info={info} busy={busy} /> : null}
                  {settingsRoute === "context" && info ? <ContextPanel controllerIdle={!busy} refreshToken={contextRefresh} initialError={initialSettings === "context" ? initialSettingsError : null} hasCompaction={info.hasCompaction} /> : null}
                </SettingsFrame>
              </div>
              <div hidden={detailTab !== "records"}>
                {recordDetail.status === "ready" && recordDetail.run.workTaskId && workTasks.tasks.some(task => task.id === recordDetail.run.workTaskId) ? <button className="ghost" onClick={() => { if (recordDetail.run.workTaskId) workTasks.select(recordDetail.run.workTaskId); openTask(); }}>回到工作任务</button> : null}
                <RecordsPanel records={records} detail={recordDetail} focusTool={traceFocusTool}
                onBack={closeRecord}
                onRefresh={() => void reloadOpenRecords().catch(() => setError("执行记录读取失败"))}
                onOpen={runId => void openRecord(runId).catch(() => setError("执行回执读取失败"))} /></div>
              <div hidden={detailTab !== "memory"}>
                {info ? <MemoryPanel key={`${info.workspaceRoot}:${info.threadId}`} memory={info.memory} temporaryThread={info.temporaryThread}
                  libraryAvailable={info.memoryLibrary === true} onManage={() => openSettings("memory")} threadId={info.threadId} controllerIdle={!busy} refreshToken={memoryRefresh} /> : null}
              </div>
              <div hidden={detailTab !== "pomodoro"}>{info ? info.pomodoroControls === true ? <PomodoroPanel enabled={info.commands.includes("pomodoro")} busy={busy} output={output} /> : <p role="status">当前助手宿主仍是旧版本，请加载新版本后使用番茄钟。</p> : null}</div>
            </div>
          </section>
      </section>
      {searchOpen ? <SearchOverlay drafts={threadDrafts} busy={busy || switchingThread} onClose={() => setSearchOpen(false)} onOpenThread={id => { setSearchOpen(false); void selectConversation(id); }} /> : null}
    </div>
  );
}
