import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type MainToRenderer, type RendererApi } from "../shared/ui-contract.js";
import { IPC_FORWARDS, forwardChannel, type ForwardTarget, type ForwardedMethod } from "../shared/ipc-forwards.js";

const forwarded = Object.fromEntries((Object.keys(IPC_FORWARDS) as ForwardTarget[]).flatMap(target =>
  Object.entries(IPC_FORWARDS[target]).map(([method, arity]) => [method,
    (...args: unknown[]) => ipcRenderer.invoke(forwardChannel(target, method), ...args.slice(0, arity))]))) as Pick<RendererApi, ForwardedMethod>;

const api: RendererApi = {
  ...forwarded,
  loadConversationDraft: scope => ipcRenderer.invoke(IPC.draftLoad, scope),
  saveConversationDraft: (scope, draft) => ipcRenderer.invoke(IPC.draftSave, scope, draft),
  saveTaskDraft: (scope, update) => ipcRenderer.invoke(IPC.taskDraftSave, scope, update),
  acknowledgeSteer: (scope, id) => ipcRenderer.invoke(IPC.steerAcknowledge, scope, id),
  releaseSteer: (scope, id) => ipcRenderer.invoke(IPC.steerRelease, scope, id),
  takeTaskResultOpen: () => ipcRenderer.invoke(IPC.taskResultOpen),
  rssWorkerStatus: () => ipcRenderer.invoke(IPC.rssWorkerStatus),
  setRssWorkerEnabled: enabled => ipcRenderer.invoke(IPC.rssWorkerEnabled, enabled),
  notificationStatus: () => ipcRenderer.invoke(IPC.notificationStatus),
  testNotification: () => ipcRenderer.invoke(IPC.notificationTest),
  openNotificationSettings: () => ipcRenderer.invoke(IPC.notificationSettings),
  info: () => ipcRenderer.invoke(IPC.info),
  backupData: () => ipcRenderer.invoke(IPC.backupData),
  restoreData: id => ipcRenderer.invoke(IPC.restoreData, id),
  previewRestoreData: () => ipcRenderer.invoke(IPC.previewRestoreData),
  activateRestoreData: id => ipcRenderer.invoke(IPC.activateRestoreData, id),
  steer: input => ipcRenderer.invoke(IPC.steer, input),
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

// Native chrome is outside React. Reserve its space only in the macOS app,
// not in the browser fixture or on platforms that retain the frameless shell.
window.addEventListener("DOMContentLoaded", () => {
  if (process.platform === "darwin") document.documentElement.dataset.nativeWindowControls = "macos";
}, { once: true });
