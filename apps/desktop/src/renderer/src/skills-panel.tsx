import { useEffect, useRef, useState } from "react";
import type { AutomationOverview } from "@serika/example-cli";
import type { RecipeChange, RecipeEntry } from "@serika/example-cli";
import { DreamingPanel } from "./dreaming-panel.js";

export function SkillsPanel({ busy, identity, refreshSequence, onUseRecipe }: { busy: boolean; identity: string; refreshSequence: number; onUseRecipe: (text: string) => void }) {
  const [overview, setOverview] = useState<AutomationOverview | null>(null);
  const [recipes, setRecipes] = useState<RecipeEntry[] | null>(null);
  const [error, setError] = useState("");
  const [recipeError, setRecipeError] = useState("");
  const [working, setWorking] = useState(false);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const [change, setChange] = useState<RecipeChange | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const reload = async () => {
    const id = ++generation.current; setError(""); setRecipeError("");
    const [skills, commands] = await Promise.allSettled([window.runloom.getAutomationOverview(), window.runloom.listRecipes()]);
    if (id !== generation.current) return;
    if (skills.status === "fulfilled" && skills.value.ok) setOverview(skills.value.value);
    else { setOverview(null); setError(skills.status === "fulfilled" && !skills.value.ok ? skills.value.error.message : "技能读取失败，请刷新。"); }
    if (commands.status === "fulfilled" && commands.value.ok) setRecipes(commands.value.value);
    else { setRecipes(null); setRecipeError(commands.status === "fulfilled" && !commands.value.ok ? commands.value.error.message : "命令配方读取失败，请刷新。"); }
  };
  useEffect(() => { void reload(); return () => { generation.current++; }; }, [identity, refreshSequence]);
  const act = async (operation: () => Promise<{ ok: boolean; error?: { message: string } }>, success: string) => {
    if (busy || inFlight.current) return;
    inFlight.current = true; setWorking(true); setNotice("");
    try { const result = await operation(); setNotice(result.ok ? success : result.error?.message ?? "未启动，请核对状态。"); }
    catch { setNotice("操作结果未确认。请刷新核对，不会自动重试。"); }
    finally { inFlight.current = false; setWorking(false); setChange(null); await reload(); }
  };
  const skills = overview?.diagnostics.skills.filter(skill => skill.kind === "text") ?? [];
  return <div className="skills-page">
    <div className="memory-actions"><button className="ghost" disabled={working} onClick={() => void reload()}>刷新技能</button></div>
    <section className="card" aria-label="文本技能"><div className="card-head"><span>文本技能</span></div>
      <p className="hint">复用一套文字处理方法。来自运行配置加载的 Skill，不具有工具或安装权限。</p>
      {error ? <p className="error" role="alert">{error}</p> : overview && !skills.length ? <p className="hint">当前未加载文本技能。添加可信 Skill 配置并重新加载后会显示在这里。</p> : null}
      {skills.length ? <label>交给技能的内容<textarea aria-label="技能输入" value={input} onChange={event => setInput(event.target.value)} disabled={working || busy} /></label> : null}
      {skills.map(skill => <div className="capability-row" key={skill.id}><div><strong>{skill.description || skill.id}</strong><p className="hint">文本技能 · 已加载 · 无工具</p><details><summary>来源与版本</summary><p>来源：运行配置登记的 Skill · {skill.id}</p><code>{skill.hash}</code></details></div><button className="ghost" disabled={busy || working || !input.trim()} onClick={() => void act(() => window.runloom.runSkill({ id: skill.id, expectedHash: skill.hash, input }), "技能已启动；请在对话中查看实际结果。")}>执行</button></div>)}
    </section>
    <section className="card" aria-label="命令配方"><div className="card-head"><span>命令配方</span></div><p className="hint">复用实际测试后登记的命令，每次执行仍需批准。版本只固定命令文本，引用的脚本与依赖可能变化。</p>
      {recipeError ? <p className="error" role="status">{recipeError}</p> : recipes && !recipes.length ? <p className="hint">还没有命令配方。在对话中完成一个具体任务并测试成功后，可以要求登记以便下次复用。</p> : null}
      {recipes?.map(recipe => {
        const version = recipe.versions.find(item => item.hash === recipe.activeHash)!;
        return <div className="recipe-entry" key={recipe.id}><strong>{version.description}</strong><p className="hint">命令配方 · {recipe.enabled ? "可用" : "已停用"}</p>
          <div className="memory-actions"><button className="ghost" disabled={busy || working || !recipe.enabled} onClick={() => onUseRecipe(`请先读取 recipe_list，核对命令配方 ${recipe.id} 当前启用且 hash 为 ${recipe.activeHash}，再请求我批准本次 recipe_run。版本不匹配或已停用请停止，不要修改配方或替换命令。`)}>在新对话中使用</button><button className="ghost" disabled={busy || working} onClick={() => setChange({ id: recipe.id, expectedRevision: recipe.revision, action: recipe.enabled ? "disable" : "enable" })}>{recipe.enabled ? "停用…" : "启用…"}</button></div>
          <details><summary>命令、来源与历史版本</summary><p>编号：{recipe.id} · revision {recipe.revision}</p><pre>{version.command}</pre><p>工作目录：{version.cwd}</p><code>{version.hash}</code><p className="hint">来源：实际成功的 Shell 回执 {version.tested.toolCallId}</p>{recipe.versions.filter(item => item.hash !== recipe.activeHash).map(item => <div key={item.hash}><p>{item.description}</p><pre>{item.command}</pre><p>工作目录：{item.cwd}</p><code>{item.hash}</code><button className="ghost" disabled={busy || working} onClick={() => setChange({ id: recipe.id, expectedRevision: recipe.revision, action: "rollback", hash: item.hash })}>切换到此版本…</button></div>)}</details>
        </div>;
      })}
      {change ? <div className="memory-setup-preview"><strong>{change.action === "disable" ? "停用" : change.action === "enable" ? "启用" : "回退"}配方 {change.id}？</strong><p className="hint">只修改配方登记状态，不执行命令、不恢复权限。提交时重新核对版本。</p>{change.hash ? <code>{change.hash}</code> : null}<div className="memory-actions"><button disabled={busy || working} onClick={() => void act(() => window.runloom.changeRecipe(change), "配方状态已保存。")}>确认变更</button><button className="ghost" disabled={working} onClick={() => setChange(null)}>取消</button></div></div> : null}
    </section>
    {notice ? <p role="status">{notice}</p> : null}
    <DreamingPanel busy={busy} identity={identity} refreshSequence={refreshSequence} />
  </div>;
}
