import React from "react";
import { FormalMemories } from "./formal-memories.js";
import { MemoryExtractionFailureHistory } from "./memory-extraction-failures.js";
import { MemoryLibraryPanel } from "./memory-library.js";

/** Saved memories only. There is no review queue: memory is saved automatically or not at all. */
export function MemoryPanel(props: { libraryAvailable?: boolean; onManage?: () => void; managementOnly?: boolean; memory: { enabled: boolean; autoConsolidate: boolean }; threadId?: string; temporaryThread: boolean; controllerIdle: boolean; refreshToken: number }) {
  return <div className="personal-memory">
    {!props.managementOnly ? <MemoryExtractionFailureHistory enabled={props.memory.enabled} refreshToken={props.refreshToken} busy={!props.controllerIdle} /> : null}
    {props.managementOnly ? <FormalMemories enabled={props.memory.enabled} controllerIdle={props.controllerIdle} refreshToken={props.refreshToken} managementOnly />
      : props.libraryAvailable ? <MemoryLibraryPanel enabled={props.memory.enabled} controllerIdle={props.controllerIdle} refreshToken={props.refreshToken} onManage={props.onManage} />
      : <p role="status">当前助手宿主需要更新后才能使用记忆文件夹。</p>}
  </div>;
}
