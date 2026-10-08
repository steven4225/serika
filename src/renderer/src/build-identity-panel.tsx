import type { AppBuildInfo, DesktopBuildManifest, SourceRevision } from "../../shared/build-identity.js";
import { buildStatus } from "../../shared/build-identity.js";
import React, { useEffect, useState } from "react";

declare const __SERIKA_BUILD__: DesktopBuildManifest | undefined;
const rendererBuild = typeof __SERIKA_BUILD__ === "undefined" ? null : __SERIKA_BUILD__ ?? null;

function revision(value: SourceRevision): string {
  return value.revision ? `${value.revision.slice(0, 12)}${value.dirty ? "（含未提交修改）" : ""}` : "未记录";
}

export function BuildIdentityPanel({ info }: { info: AppBuildInfo | undefined }) {
  const [current, setCurrent] = useState(info);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setCurrent(info); }, [info]);
  const check = async () => {
    setChecking(true); setError(null);
    try { setCurrent((await window.runloom.info()).build); }
    catch { setError("版本核对失败，仍显示上次已加载信息。"); }
    finally { setChecking(false); }
  };
  if (!current) return <details><summary>当前版本</summary><p className="hint">当前入口未提供构建标识，不能确认版本。</p></details>;
  const status = buildStatus(current, rendererBuild);
  return <details>
    <summary>当前版本{status.warning ? " · 需要核对" : ""}</summary>
    <p className={status.warning ? "error" : "hint"} role="status">{status.text}</p>
    {current.loaded ? <>
      <p>已加载主进程：{current.loaded.version} · <code>{current.loaded.id}</code><br />已加载页面：<code>{rendererBuild?.id ?? "未标记"}</code></p>
      <p className="hint">构建时间：{current.loaded.builtAt}<br />桌面源码：{revision(current.loaded.frontendSource)}</p>
      <p className="hint">启动时后端产物：<code>{current.backendDistAtStartup?.slice(0, 16) ?? "未读取"}</code><br />构建时后端源码参考：{revision(current.loaded.backendSource)}（不是已编译证明）</p>
      {current.diskBuild === "different" ? <p className="hint">磁盘桌面构建：<code>{current.diskBuildId}</code>。上方始终显示已加载版本。</p> : null}
    </> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    <button className="ghost" disabled={checking} onClick={() => void check()}>{checking ? "正在核对…" : "核对磁盘构建"}</button>
  </details>;
}
