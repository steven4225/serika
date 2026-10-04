import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type MainToRenderer, type RendererApi } from "../shared/ui-contract.js";

const api: RendererApi = {
  listThreads: () => ipcRenderer.invoke(IPC.threadsList),
  createThread: () => ipcRenderer.invoke(IPC.threadCreate),
  selectThread: id => ipcRenderer.invoke(IPC.threadSelect, id),
  chooseHistoryDirectory: () => ipcRenderer.invoke(IPC.historyDirectory),
  discoverThreads: directory => ipcRenderer.invoke(IPC.threadsDiscover, directory),
  registerThread: input => ipcRenderer.invoke(IPC.threadRegister, input),
  enableMemory: () => ipcRenderer.invoke(IPC.memoryEnable),
  consolidateMemory: input => ipcRenderer.invoke(IPC.memoryConsolidate, input),
  listMemoryConsolidationSources: offset => ipcRenderer.invoke(IPC.memoryConsolidationSources, offset),
  getRssSubscriptions: () => ipcRenderer.invoke(IPC.rssGet),
  updateRssSubscriptions: input => ipcRenderer.invoke(IPC.rssUpdate, input),
  getRssInbox: () => ipcRenderer.invoke(IPC.rssInbox),
  acknowledgeRssResult: id => ipcRenderer.invoke(IPC.rssAck, id),
  rssWorkerStatus: () => ipcRenderer.invoke(IPC.rssWorkerStatus),
  setRssWorkerEnabled: enabled => ipcRenderer.invoke(IPC.rssWorkerEnabled, enabled),
  info: () => ipcRenderer.invoke(IPC.info),
  snapshot: () => ipcRenderer.invoke(IPC.snapshot),
  history: () => ipcRenderer.invoke(IPC.history),
  home: () => ipcRenderer.invoke(IPC.home),
  run: (text, options) => ipcRenderer.invoke(IPC.run, text, options),
  cancel: () => ipcRenderer.invoke(IPC.cancel),
  confirm: (input) => ipcRenderer.invoke(IPC.confirm, input),
  command: (line) => ipcRenderer.invoke(IPC.command, line),
  listRuns: () => ipcRenderer.invoke(IPC.listRuns),
  getRun: (runId) => ipcRenderer.invoke(IPC.getRun, runId),
  getContextDiagnostics: () => ipcRenderer.invoke(IPC.contextDiagnostics),
  listMemories: input => ipcRenderer.invoke(IPC.memoriesList, input),
  getMemory: id => ipcRenderer.invoke(IPC.memoryGet, id),
  updateMemory: input => ipcRenderer.invoke(IPC.memoryUpdate, input),
  getMemoryHistory: input => ipcRenderer.invoke(IPC.memoryHistory, input),
  queryMemory: input => ipcRenderer.invoke(IPC.memoryQuery, input),
  previewMemoryAction: input => ipcRenderer.invoke(IPC.memoryPreview, input),
  applyMemoryAction: input => ipcRenderer.invoke(IPC.memoryApply, input),
  getMemoryMaintenance: () => ipcRenderer.invoke(IPC.memoryMaintenance),
  getMemoryReferences: () => ipcRenderer.invoke(IPC.memoryReferences),
  listMemoryCandidates: (input) => ipcRenderer.invoke(IPC.memoryCandidatesList, input),
  getMemoryCandidate: (id) => ipcRenderer.invoke(IPC.memoryCandidateGet, id),
  resolveMemoryCandidate: (input) => ipcRenderer.invoke(IPC.memoryCandidateResolve, input),
  createWorkTask: (input) => ipcRenderer.invoke(IPC.createWorkTask, input),
  listWorkTasks: () => ipcRenderer.invoke(IPC.listWorkTasks),
  getWorkTask: (id) => ipcRenderer.invoke(IPC.getWorkTask, id),
  getWorkTaskDeliveryDraft: (input) => ipcRenderer.invoke(IPC.getWorkTaskDeliveryDraft, input),
  getWorkTaskContinuation: (input) => ipcRenderer.invoke(IPC.getWorkTaskContinuation, input),
  getWorkTaskArtifact: (input) => ipcRenderer.invoke(IPC.getWorkTaskArtifact, input),
  runWorkTask: (input) => ipcRenderer.invoke(IPC.runWorkTask, input),
  submitWorkTaskDelivery: (input) => ipcRenderer.invoke(IPC.submitWorkTaskDelivery, input),
  recordHumanAcceptance: (input) => ipcRenderer.invoke(IPC.recordHumanAcceptance, input),
  reconcileWorkTask: (input) => ipcRenderer.invoke(IPC.reconcileWorkTask, input),
  cancelWorkTask: (input) => ipcRenderer.invoke(IPC.cancelWorkTask, input),
  requestWorkTaskChanges: (input) => ipcRenderer.invoke(IPC.requestWorkTaskChanges, input),
  hide: () => ipcRenderer.invoke(IPC.hide),
  onMessage: (listener) => {
    const wrapped = (_event: IpcRendererEvent, message: MainToRenderer) => listener(message);
    ipcRenderer.on(IPC.message, wrapped);
    return () => {
      ipcRenderer.off(IPC.message, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("runloom", api);
