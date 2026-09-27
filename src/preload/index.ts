import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type MainToRenderer, type RendererApi } from "../shared/ui-contract.js";

const api: RendererApi = {
  info: () => ipcRenderer.invoke(IPC.info),
  history: () => ipcRenderer.invoke(IPC.history),
  home: () => ipcRenderer.invoke(IPC.home),
  run: (text) => ipcRenderer.invoke(IPC.run, text),
  cancel: () => ipcRenderer.invoke(IPC.cancel),
  confirm: (line) => ipcRenderer.invoke(IPC.confirm, line),
  command: (line) => ipcRenderer.invoke(IPC.command, line),
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
