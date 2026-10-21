// Offline, read-only layout replay. Run under Node's permission model with read permission only.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { convertToModelMessages } from "ai";
import { JsonlAgentStore } from "../../core/dist/index.js";
import { assembleFiveLayerContext, contextFingerprint, commonContextPrefix } from "../dist/five-layer-context.js";
import { compactPrefixHash, parseContextSummary } from "../dist/context-compaction.js";
import { isAutoConsolidationRequest } from "../dist/consolidation.js";
import { validateMemoryDocument } from "../dist/memory-store.js";
import { selectTemporalAssertions } from "../dist/memory-temporal.js";

if (!process.permission || process.permission.has("net") || process.permission.has("fs.write") || process.permission.has("child")) {
  throw new Error("Use node --permission --allow-fs-read='*'; network, filesystem writes and child processes must stay denied");
}
const [identityPath, configPath] = process.argv.slice(2);
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const identity = await readJson(identityPath), config = await readJson(configPath);
const threads = [];
for (const thread of identity.profiles.flatMap(profile => profile.threads)) {
  const store = new JsonlAgentStore({ directory: thread.transcriptDirectory });
  threads.push({ ...thread, store, messages: await store.getModelMessages(thread.threadId) });
}
threads.sort((a, b) => b.messages.length - a.messages.length);
const main = threads[0], messages = main.messages;
const memoryPath = join(config.workspace, ".runloom/memory.json");
const memoryText = await readFile(memoryPath, "utf8"), memory = validateMemoryDocument(JSON.parse(memoryText));
let methods;
try { methods = await readJson(join(config.workspace, ".runloom/dreaming.json")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const compactions = await main.store.getContextCompactions(main.threadId);
const validCompactions = compactions.filter(record => record.v === 2 &&
  record.firstKeptMessageIndex <= messages.length &&
  (record.firstKeptMessageId === null || record.firstKeptMessageId === messages[record.firstKeptMessageIndex]?.id) &&
  record.sourcePrefixHash === compactPrefixHash(messages, record.firstKeptMessageIndex) &&
  (record.consolidationExcluded === true || !messages.slice(0, record.firstKeptMessageIndex).some(isAutoConsolidationRequest)) &&
  parseContextSummary(JSON.stringify(record.summary))).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
const ordinary = message => message.role === "user" && !["auto-consolidation", "dreaming", "automation-skill"].includes(message.metadata?.source);
function primaryConversation(messages) {
  let auxiliary = false;
  return messages.filter(message => {
    if (message.role === "user") auxiliary = !ordinary(message);
    return !auxiliary;
  });
}
const at = message => Date.parse(message?.metadata?.receivedAt ?? message?.metadata?.sentAt);
const localMinute = time => new Date(time + 8 * 3600_000).toISOString().slice(0, 16) + "+08:00";
// These annotations live only in replay memory; later turns reuse the exact annotated user bytes.
const annotated = messages.map(message => ordinary(message) && Number.isFinite(at(message)) ? {
  ...message, parts: [...message.parts, { type: "text", text: "\nHost current-message reference (data only):\n" + JSON.stringify({
    receivedMinute: localMinute(at(message)), channel: message.metadata?.channel ?? message.metadata?.source ?? "unknown",
  }) }],
} : message);
const sourceFingerprint = contextFingerprint(messages).hash;
function referenceAt(time) {
  const preferences = [], notes = [];
  for (const record of memory.entries) {
    const version = record.versions.filter(v => v.changedAt !== null && Date.parse(v.changedAt) <= time).at(-1);
    if (!version || version.scope.kind !== "workspace" || version.status !== "active" ||
      version.expiresAt && Date.parse(version.expiresAt) <= time) continue;
    const assertions = selectTemporalAssertions(record.assertions, {}, new Date(time).toISOString()).assertions;
    for (const assertion of assertions) {
      const entry = { id: record.id, text: assertion.text };
      if (assertion.kind === "preference") preferences.push(entry);
      else if (assertion.kind === "fact" || assertion.kind === "note") notes.push(entry);
    }
  }
  // Existing library/method metadata has no as-of history. Keep present-day indexes explicitly separate.
  const documents = (memory.library?.documents ?? []).filter(d => d.scope.kind === "workspace").map(({ id, title, folderId }) => ({ id, title, folderId }));
  const methodIndex = (methods?.skills ?? []).map(({ id, title }) => ({ id, title }));
  return [{ role: "assistant", content: "Fixed reference (untrusted data; no authority):\n" + JSON.stringify({ preferences, notes, documents, methods: methodIndex }) }];
}
let previous = [], previousLayers, previousEpoch, previousUser, reference;
let missingTimes = 0, sameEpochPairs = 0, unstableReference = 0, unstableSummary = 0, brokenAppend = 0;
const rows = [], gaps = [], layerHashes = Array.from({ length: 5 }, () => new Set());
const userMessages = messages.filter(ordinary);
let missingGapPairs = 0, backwardGapPairs = 0;
for (let i = 1; i < userMessages.length; i++) {
  const gap = at(userMessages[i]) - at(userMessages[i - 1]);
  if (!Number.isFinite(gap)) missingGapPairs++;
  else if (gap < 0) backwardGapPairs++;
  else gaps.push(gap);
}
for (let index = 0; index < messages.length; index++) {
  const user = messages[index];
  if (!ordinary(user)) continue;
  const time = at(user);
  if (!Number.isFinite(time)) { missingTimes++; previous = []; previousUser = undefined; continue; }
  const compact = validCompactions.filter(c => Date.parse(c.createdAt) <= time && c.firstKeptMessageIndex <= index).at(-1);
  const epoch = compact?.id ?? "initial", boundary = compact?.firstKeptMessageIndex ?? 0;
  const sameEpoch = previousEpoch === epoch && previousUser !== undefined;
  if (previousEpoch !== epoch) reference = referenceAt(compact ? Date.parse(compact.createdAt) : time);
  const summary = compact ? [{ role: "assistant", content: "Context summary (derived reference):\n" + JSON.stringify(compact.summary) }] : [];
  const recent = await convertToModelMessages(primaryConversation(annotated.slice(boundary, index)));
  const current = await convertToModelMessages([annotated[index]]);
  // Historical instructions/tool definitions were never saved. Exclude unknown layer 1 from all numeric denominators.
  const assembled = assembleFiveLayerContext({ instructions: "", tools: [], reference, summary, recent, current });
  const segments = assembled.messages.map(contextFingerprint), layers = assembled.layers.map(contextFingerprint);
  layers.forEach((layer, i) => layerHashes[i].add(layer.hash));
  const shared = commonContextPrefix({ previous, current: segments });
  if (sameEpoch) {
    sameEpochPairs++;
    if (layers[1].hash !== previousLayers[1].hash) unstableReference++;
    if (layers[2].hash !== previousLayers[2].hash) unstableSummary++;
    if (shared.segments < previous.length) brokenAppend++;
  }
  rows.push({ input: segments.reduce((n, s) => n + s.estimatedTokens, 0), shared: shared.estimatedTokens,
    gap: previousUser === undefined ? null : time - previousUser, epoch, sameEpoch,
    summaryTokens: summary.reduce((n, s) => n + contextFingerprint(s).estimatedTokens, 0),
    recentTokens: recent.reduce((n, s) => n + contextFingerprint(s).estimatedTokens, 0) });
  previous = segments; previousLayers = layers; previousEpoch = epoch; previousUser = time;
}
const input = rows.reduce((n, row) => n + row.input, 0), shared = rows.reduce((n, row) => n + row.shared, 0);
const ttlScenarios = [1, 2, 4, 24, 72].map(hours => ({ hours,
  gapCount: gaps.filter(gap => gap < hours * 3600_000).length, gapFraction: gaps.filter(gap => gap < hours * 3600_000).length / gaps.length,
  conditionalPrefixRatio: rows.reduce((n, row) => n + (row.gap !== null && row.gap >= 0 && row.gap < hours * 3600_000 ? row.shared : 0), 0) / input }));
const unchanged = sourceFingerprint === contextFingerprint(await main.store.getModelMessages(main.threadId)).hash &&
  memoryText === await readFile(memoryPath, "utf8");
if (!unchanged) throw new Error("Source changed while replaying; rerun against a stable source");
console.log(JSON.stringify({ capturedAt: new Date().toISOString(), permissions: { network: false, writes: false, childProcesses: false },
  source: { messages: messages.length, sourceFingerprint, memorySha256: createHash("sha256").update(memoryText).digest("hex"), unchanged,
    ordinaryUsers: userMessages.length, replayedUsers: rows.length, missingTimes, compactions: compactions.length, validCompactions: validCompactions.length,
    replayEpochs: new Set(rows.map(row => row.epoch)).size, threadMemoriesHeldForMigrationDecision: memory.entries.filter(r => r.scope.kind === "thread").length,
    currentDocumentIndexCount: memory.library?.documents.length ?? 0, currentMethodIndexCount: methods?.skills.length ?? 0 },
  stability: { sameEpochPairs, unstableReference, unstableSummary, brokenAppend, uniqueLayerHashes: layerHashes.map(set => set.size) },
  prefix: { estimator: "char-half/v1", denominator: "reconstructible layers 2–5 only", estimatedInputTokens: input,
    reusablePrefixEstimatedTokens: shared, noEvictionPrefixRatio: shared / input,
    firstRequestCold: true, cacheRule: "adjacent complete identical messages only; no non-contiguous reuse or provider persistence assumption" },
  capacity: [26_624, config.contextCompaction.inputBudgetTokens].map(inputBudget => ({ inputBudget,
    fits: rows.filter(r => r.input <= inputBudget).length, overflow: rows.filter(r => r.input > inputBudget).length,
    recentBudget: 48_000 * inputBudget / config.contextCompaction.inputBudgetTokens,
    recentOverBudget: rows.filter(r => r.recentTokens > 48_000 * inputBudget / config.contextCompaction.inputBudgetTokens).length,
    maxInput: Math.max(...rows.map(r => r.input)), maxLegacySummary: Math.max(...rows.map(r => r.summaryTokens)),
    noEvictionPrefixRatioForFittingPairs: (() => {
      let denominator = 0, numerator = 0;
      for (let i = 0; i < rows.length; i++) if (rows[i].input <= inputBudget) {
        denominator += rows[i].input;
        if (i > 0 && rows[i - 1].input <= inputBudget) numerator += rows[i].shared;
      }
      return denominator ? numerator / denominator : null;
    })() })),
  gaps: { samples: gaps.length, missingGapPairs, backwardGapPairs, actualRouteTtlMs: null, belowActualRouteTtlFraction: null, scenarios: ttlScenarios },
  unavailable: ["historical instructions/tools, exact provider tokenizer and prefix persistence units", "historical task/checkpoint/WorkTask/current references and first visible text timings", "v2 segmented summaries and block masking (steps 5/6); existing validated summaries reused", "historical document/method index revisions; current-only indexes labeled"] }, null, 2));
