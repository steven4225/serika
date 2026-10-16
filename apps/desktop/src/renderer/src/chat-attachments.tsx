import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { ChatAttachment } from "@aisdk-agent/example-cli/dist/chat-attachments.js";
export type { ChatAttachment };

async function readAttachment(file: File): Promise<ChatAttachment> {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const mediaType = extension === "png" ? "image/png" : ["jpg", "jpeg"].includes(extension ?? "") ? "image/jpeg" : extension === "txt" ? "text/plain" : extension === "md" ? "text/markdown" : null;
  if (!mediaType) throw new Error("请选择 PNG、JPG、TXT 或 MD 文件");
  if (!file.size || file.size > (mediaType.startsWith("image/") ? 5 * 1024 * 1024 : 128 * 1024)) throw new Error("附件为空或过大：图片最多 5 MiB，文本最多 128 KiB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (mediaType === "image/png" && ![137,80,78,71,13,10,26,10].every((byte, i) => bytes[i] === byte)) throw new Error("PNG 图片已损坏，请重新选择");
  if (mediaType === "image/jpeg" && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) throw new Error("JPG 图片已损坏，请重新选择");
  if (!mediaType.startsWith("image/")) {
    if (bytes.includes(0)) throw new Error("文本文件含有二进制内容，请选择 UTF-8 文本");
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("文本文件需使用 UTF-8 编码"); }
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { name: file.name, mediaType, data: btoa(binary) };
}

export function AttachmentChooser({ disabled, onPicked, onError }: { disabled: boolean; onPicked: (files: ChatAttachment[]) => void; onError: (error: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <><button type="button" className="ghost" disabled={disabled} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); input.current?.click(); }}>添加附件</button>
    <input ref={input} type="file" hidden multiple accept=".png,.jpg,.jpeg,.txt,.md" onChange={event => {
      const files = Array.from(event.target.files ?? []); event.target.value = "";
      if (working.current || !files.length) return;
      if (files.length > 4 || files.reduce((sum, file) => sum + file.size, 0) > 10 * 1024 * 1024) { onError("每条最多 4 个附件，总大小不超过 10 MiB"); return; }
      working.current = true;
      void Promise.all(files.map(readAttachment)).then(files => { if (mounted.current) onPicked(files); }).catch(cause => { if (mounted.current) onError(cause instanceof Error ? cause.message : "附件读取失败，请重新选择"); }).finally(() => { working.current = false; });
    }} />
  </>;
}
export function AttachmentPreview({ attachments, setAttachments, disabled }: { attachments: ChatAttachment[]; setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>; disabled: boolean }) {
  return attachments.length ? <div className="chat-attachments" aria-label="待发送附件">{attachments.map((attachment, index) => <div className="chat-attachment" key={`${index}:${attachment.name}`}>
    {attachment.mediaType.startsWith("image/") ? <img src={`data:${attachment.mediaType};base64,${attachment.data}`} alt={attachment.name} /> : null}
    <span>{attachment.name}</span><button type="button" className="ghost" aria-label={`移除 ${attachment.name}`} disabled={disabled} onClick={() => setAttachments(items => items.filter((_, i) => i !== index))}>×</button>
  </div>)}<small>附件仅保留在本窗口草稿中；切换对话或刷新前请先发送。图片需当前模型支持。</small></div> : null;
}
