import React from "react";
import type { FormalMemory } from "@aisdk-agent/example-cli/dist/memory-management.js";
import type { MemoryActionPreview, MemoryHistoryPage, MemoryMaintenance } from "@aisdk-agent/example-cli/dist/memory-controls.js";
import type { MemoryAssertion, MemorySource, MemoryTemporalView } from "@aisdk-agent/example-cli/dist/memory-store.js";
import { memoryKindLabel, timestampLabel } from "./memory-temporal-data.js";

export function MemorySources({ sources }: { sources: readonly MemorySource[] }) {
  return <section className="memory-sources"><div className="memory-label">保存来源</div>
    {sources.length === 0 ? <p className="hint">没有附带可核对的来源。</p> : sources.map((source, index) => <div key={index}>
      {source.kind === "conversation" ? <><blockquote className="memory-text">{source.quote}</blockquote><div className="hint">Thread {source.threadId} · 消息 {source.messageId}</div></> :
        <p className="hint">{source.kind === "manual" ? "用户手动记录或纠正" : "旧格式迁入，未附原话"}</p>}
    </div>)}
  </section>;
}

export function MemoryTimeDetails({ assertion }: { assertion: Pick<MemoryAssertion, "validTime" | "systemTime"> }) {
  const { validTime, systemTime } = assertion;
  return <dl className="memory-times">
    <dt>事实适用时间</dt><dd>{timestampLabel(validTime.from, "开始时间未知")} 至 {timestampLabel(validTime.to, "没有已知结束时间")}</dd>
    <dt>时间依据</dt><dd>{validTime.basis === "explicit" ? "明确指定" : validTime.basis === "reported" ? "从报告时刻起记录，不等于真实开始时间" : "未知，不推断实际发生时间"}</dd>
    <dt>系统记录时间</dt><dd>{timestampLabel(systemTime.from, "记录时间未知")} 至 {timestampLabel(systemTime.to, "仍为系统当前记录")}</dd>
  </dl>;
}

export function MemoryAssertionDetails({ assertion, showSources = true }: { assertion: MemoryAssertion; showSources?: boolean }) {
  return <section className="memory-assertion">
    <div className="hint">{memoryKindLabel[assertion.kind]} · {assertion.state === "retracted" ? "已撤回" : "已记录"} · {assertion.assertionId}</div>
    <pre className="memory-text">{assertion.text}</pre>
    <MemoryTimeDetails assertion={assertion} />
    <p className="hint">检索词：{assertion.recallTerms.length ? assertion.recallTerms.join("、") : "未设置"}（只用于匹配，不作为事实注入）</p>
    {showSources ? <MemorySources sources={assertion.sources} /> : null}
  </section>;
}

export function MemoryHistory({ page, onRestore, ready }: { page: MemoryHistoryPage; onRestore: (assertion: MemoryAssertion) => void; ready: boolean }) {
  return <section className="memory-history">
    <p className="hint">{page.historyCoverage === "legacy_partial" ? "历史不完整：旧格式或不可见的历史没有被补造，无法保证查询覆盖全部过去。" : "展示已保存的历史；事实何时适用与系统何时知道是两条不同的时间线。"}</p>
    <div className="memory-history-assertions">{page.assertions.map(assertion => <section className="memory-history-entry" key={assertion.assertionId}>
      <MemoryAssertionDetails assertion={assertion} />
      {assertion.state === "asserted" ? <button className="ghost" disabled={!ready} onClick={() => onRestore(assertion)}>恢复这份内容…</button> : <p className="hint">撤回标记不能作为恢复内容，请选择更早的有效断言。</p>}
    </section>)}</div>
    <details className="memory-administrative-history"><summary>管理变更（固定、停用与有效期）</summary>
      <p className="hint">同一份内容可以有多个管理版本；它们不是多条新的事实。</p>
      {page.versions.map(version => <div className="memory-history-version" key={version.revision}>
        <span>revision {version.revision} · {version.status === "disabled" ? "停用" : "启用"} · {version.pinned ? "固定" : "未固定"}</span>
        <p className="hint">保存于 {timestampLabel(version.changedAt, "未知")} · 有效期 {timestampLabel(version.expiresAt, "无")} · {version.scope.kind === "thread" ? "当前 Thread" : "工作区"}</p>
        <p className="hint">关联断言 {version.assertionId}</p>
      </div>)}
    </details>
  </section>;
}

export function MemoryTemporalQueryResult({ view }: { view: MemoryTemporalView }) {
  return <section className="memory-temporal-query-result">
    {view.historyCoverage === "legacy_partial" ? <p className="hint">历史覆盖不完整，查询不能证明过去没有其他记录。</p> : null}
    {view.validTimeUncertain ? <p className="hint">部分事实的适用时间未知。</p> : null}
    {view.systemTimeUncertain ? <p className="hint">部分系统记录时间未知。</p> : null}
    {view.assertions.length === 0 ? <p className="hint">这个时间视图没有可见断言，不代表记忆已被永久删除。</p> : view.assertions.map(assertion => <MemoryAssertionDetails assertion={assertion} key={assertion.assertionId} />)}
  </section>;
}

export function MemoryMaintenanceSummary({ value }: { value: MemoryMaintenance }) {
  const labels = { off: "关闭", backlog: "有待处理材料", running: "整理中", failed: "整理失败", awaiting_review: "等待审核", idle: "暂无待处理材料" };
  return <section className="memory-maintenance-summary">
    <p>自动整理：{labels[value.consolidation.state]}</p>
    {value.consolidation.error ? <p className="error" role="alert">{value.consolidation.error}</p> : null}
    <p className="hint">正式记忆 {value.stored} / {value.capacity.entries} · 待审核 {value.pending} · 已过期 {value.expired} · 已停用 {value.disabled} · 重复建议 {value.duplicateSuggestions}</p>
    {value.consolidation.backlogCount !== undefined ? <p className="hint">待整理用户材料：{value.consolidation.backlogCount} 条。</p> : null}
    <p className="hint">文件上限 {Math.round(value.capacity.bytes / 1024 / 1024)} MiB，每条最多 {value.capacity.assertionsPerEntry} 份断言。达到容量会报错，不会自动裁剪或清理。</p>
  </section>;
}

export function MemoryActionPreviewDetails({ preview }: { preview: MemoryActionPreview }) {
  const { input, current, proposedAssertion } = preview;
  return <section className="memory-action-preview-details">
    <div className="memory-label">当前内容</div><pre className="memory-text">{current.text}</pre>
    {proposedAssertion ? <><div className="memory-label">拟保存的断言</div><MemoryAssertionDetails assertion={proposedAssertion} /></> : null}
    {input.operation === "metadata" ? <p className="hint">
      {input.pinned !== undefined ? input.pinned ? "固定此记忆。固定仍受范围、有效期和注入预算约束。" : "取消固定，之后按问题匹配。" : null}
      {input.status === "disabled" ? "停用后不会注入；内容和历史保留，可显式恢复。" : null}
      {input.expiresAt !== undefined ? `有效期：${timestampLabel(current.expiresAt, "无")} 改为 ${timestampLabel(input.expiresAt, "无")}。` : null}
    </p> : null}
    {input.operation === "correct" ? <p className="hint">这是纠正记录，不声明现实在此刻发生变化；保留旧的系统认知供历史查询。</p> : null}
    {input.operation === "change" ? <p className="hint">实际变化发生于 {timestampLabel(input.effectiveAt, "未知")}；此前适用的事实会保留。</p> : null}
    {input.operation === "retract" ? <p className="hint">撤回当前断言后不再注入，历史仍保留。旧对话、旧摘要和已经发出的回复不会被删除。</p> : null}
    {input.operation === "restore" ? <p className="hint">恢复为新的 revision，从确认保存时起适用；不重启旧任务，不恢复工具授权。</p> : null}
    {input.operation === "delete" ? <p className="error">永久删除本条正式记忆、历史和相关候选内容，不能从这里恢复。旧对话与已发出的回复不会因此删除。</p> : null}
    {preview.warnings.map((warning, index) => <p className="hint" key={index}>{warning}</p>)}
  </section>;
}

export function CurrentMemoryDetails({ current, assertion }: { current: FormalMemory; assertion: MemoryAssertion | undefined }) {
  const metadata = current.assertion;
  return <section className="memory-current-content">
    <div className="memory-label">当前适用内容</div>{current.text ? <pre className="memory-text">{current.text}</pre> : <p className="hint">{current.temporalState === "retracted" ? "已撤回，不再注入。历史保留，可从下面选择有效内容恢复。" : "当前没有适用内容，可查看历史及事实适用时间。"}</p>}
    {metadata ? <><p className="hint">{memoryKindLabel[metadata.kind]} · {metadata.state === "retracted" ? "已撤回，不再注入" : "已记录"} · 断言 {metadata.assertionId}</p><MemoryTimeDetails assertion={metadata} />
      <p className="hint">检索词：{metadata.recallTerms.length ? metadata.recallTerms.join("、") : "未设置"}</p></> : current.temporalState === undefined ? <p className="hint">旧格式记录：没有完整的断言与时间元数据。</p> : null}
    {metadata || current.temporalState === undefined ? <MemorySources sources={assertion?.sources ?? (current.source ? [current.source] : [])} /> : null}
  </section>;
}
