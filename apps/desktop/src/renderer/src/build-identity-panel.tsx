import type { AppBuildInfo, DesktopBuildManifest, SourceRevision } from "../../shared/build-identity.js";
import { buildStatus, workerBuildStatus } from "../../shared/build-identity.js";
import type { RssWorkerResponse } from "../../shared/ui-contract.js";
import React, { useEffect, useState } from "react";
import { SerikaMark } from "./icons.js";

declare const __SERIKA_BUILD__: DesktopBuildManifest | undefined;
const rendererBuild = typeof __SERIKA_BUILD__ === "undefined" ? null : __SERIKA_BUILD__ ?? null;

function revision(value: SourceRevision): string {
  return value.revision ? `${value.revision.slice(0, 12)}${value.dirty ? "（含未提交修改）" : ""}` : "未记录";
}

export function BuildIdentityPanel({ info, worker: initialWorker = null }: { info: AppBuildInfo | undefined; worker?: RssWorkerResponse | null }) {
  const [current, setCurrent] = useState(info);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [worker, setWorker] = useState(initialWorker);
  useEffect(() => { setCurrent(info); }, [info]);
  useEffect(() => {
    let active = true;
    void window.runloom.rssWorkerStatus().then(value => { if (active) setWorker(value); })
      .catch(() => { if (active) setWorker({ ok: false, message: "后台版本状态不可读取，不能确认已加载新码。" }); });
    return () => { active = false; };
  }, [info]);
  const check = async () => {
    setChecking(true); setError(null);
    try {
      const [next, service] = await Promise.all([window.runloom.info(), window.runloom.rssWorkerStatus()]);
      setCurrent(next.build); setWorker(service);
    }
    catch { setError("版本核对失败，仍显示上次已加载信息。"); }
    finally { setChecking(false); }
  };
  if (!current) return <details className="build-identity"><summary><SerikaMark size={18} />当前版本</summary><p className="hint">当前入口未提供构建标识，不能确认版本。</p></details>;
  const status = buildStatus(current, rendererBuild);
  const background = worker?.ok === true ? workerBuildStatus(worker, rendererBuild ?? current.loaded)
    : worker?.ok === false ? { warning: true, text: `后台版本状态不可用：${worker.message.trimEnd().replace(/[。.]+$/, "")}。不能确认已加载新码；不会自动停止服务。` } : null;
  return <details className="build-identity">
    <summary><SerikaMark size={18} />当前版本{status.warning || background?.warning ? " · 需要核对" : ""}</summary>
    <p className={status.warning ? "error" : "hint"} role="status">{status.text}</p>
    {background ? <p className={background.warning ? "error" : "hint"} role="status">{background.text}</p> : null}
    {current.loaded ? <>
      <p>{current.host === "resident" ? "已加载常驻助手" : "已加载主进程"}：{current.loaded.version} · <code>{current.loaded.id}</code><br />已加载页面：<code>{rendererBuild?.id ?? "未标记"}</code></p>
      <p className="hint">构建时间：{current.loaded.builtAt}<br />桌面源码：{revision(current.loaded.frontendSource)}</p>
      <p className="hint">启动时后端产物：<code>{current.backendDistAtStartup?.slice(0, 16) ?? "未读取"}</code><br />构建时后端源码参考：{revision(current.loaded.backendSource)}（不是已编译证明）</p>
      {current.diskBuild === "different" ? <p className="hint">磁盘桌面构建：<code>{current.diskBuildId}</code>。上方始终显示已加载版本。</p> : null}
    </> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    <button className="ghost" disabled={checking} onClick={() => void check()}>{checking ? "正在核对…" : "核对磁盘构建"}</button>
  </details>;
}
