import { useState } from "react";
export function BackupPanel({ busy }: { busy: boolean }) {
  const [working, setWorking] = useState(false), [message, setMessage] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const perform = async (restore: boolean) => {
    if (busy || working) return;
    setWorking(true); setError(null); setMessage(null);
    try {
      const result = restore ? await window.runloom.restoreData() : await window.runloom.backupData();
      if (result) setMessage(`${restore ? "恢复副本已保存，日用数据未覆盖、旧任务未启动" : "备份已保存"}：${result.path}（${result.threads} 个对话，${result.files} 个数据文件）`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，未确认备份或恢复成功"); }
    finally { setWorking(false); }
  };
  return <section aria-label="数据备份与恢复">
    <h3>数据备份与恢复</h3>
    <p className="hint">备份当前工作区的对话、记忆、快照、任务和回执；不包含项目文件、配置、API key 或 Telegram 凭据文件。正文仍可能含有你写过的敏感信息，请保存在可信位置。</p>
    <p className="hint">备份逐份读取已保存的数据，不是跨文件同一时刻的快照。恢复只创建数据副本，不覆盖日用数据、不切换工作区、不接通服务；旧单次排期取消、重复排期暂停。它不是一键回滚，恢复副本中的记忆和任务不会自动成为当前数据。</p>
    <div className="actions"><button className="ghost" disabled={busy || working} onClick={() => void perform(false)}>导出备份</button><button className="ghost" disabled={busy || working} onClick={() => void perform(true)}>恢复副本</button></div>
    {working ? <p role="status">正在处理，请勿退出…</p> : null}
    {message ? <p role="status">{message}</p> : null}{error ? <p className="error" role="alert">{error}</p> : null}
  </section>;
}
