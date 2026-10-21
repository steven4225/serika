// Read committed daily-use data without assembling a runtime or acquiring a writer lease.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonlAgentStore } from "../../core/dist/index.js";

const identity = JSON.parse(await readFile(process.argv[2], "utf8"));
const threads = identity.profiles.flatMap(profile => profile.threads);
const results = [];
const percentile = (values, p) => values.length ? values[Math.ceil(values.length * p) - 1] : null;
for (const thread of threads) {
  const store = new JsonlAgentStore({ directory: thread.transcriptDirectory });
  const messages = await store.getModelMessages(thread.threadId);
  const users = messages.filter(message => message.role === "user" &&
    !["auto-consolidation", "dreaming", "automation-skill"].includes(message.metadata?.source));
  let journal;
  try { journal = JSON.parse(await readFile(join(thread.transcriptDirectory, "execution-records.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const calls = (journal?.modelUsage?.calls ?? []).filter(call => call.threadId === thread.threadId);
  const purposes = {};
  for (const call of calls) {
    const stats = purposes[call.purpose] ??= { calls: 0, returned: 0, usagePairs: 0, input: 0, cacheRead: 0, output: 0, outputKnown: 0, durations: [] };
    stats.calls++;
    if (call.status !== "returned") continue;
    stats.returned++;
    if (call.usage.inputTokens !== undefined && call.usage.cacheReadTokens !== undefined) {
      stats.usagePairs++; stats.input += call.usage.inputTokens; stats.cacheRead += call.usage.cacheReadTokens;
    }
    if (call.usage.outputTokens !== undefined) { stats.outputKnown++; stats.output += call.usage.outputTokens; }
    if (call.finishedAt !== null) stats.durations.push(Date.parse(call.finishedAt) - Date.parse(call.startedAt));
  }
  for (const stats of Object.values(purposes)) {
    stats.durations.sort((a, b) => a - b);
    stats.durationMedianMs = percentile(stats.durations, 0.5);
    stats.cacheReadRatio = stats.input ? stats.cacheRead / stats.input : null;
    delete stats.durations;
  }
  const gaps = [], buckets = { "<1m": 0, "1–5m": 0, "5–30m": 0, "30m–2h": 0, ">=2h": 0 };
  let missingPairs = 0, backwardsPairs = 0;
  const at = message => Date.parse(message?.metadata?.receivedAt ?? message?.metadata?.sentAt);
  for (let i = 1; i < users.length; i++) {
    const gap = at(users[i]) - at(users[i - 1]);
    if (!Number.isFinite(gap)) { missingPairs++; continue; }
    if (gap < 0) { backwardsPairs++; continue; }
    gaps.push(gap);
    buckets[gap < 60_000 ? "<1m" : gap < 300_000 ? "1–5m" : gap < 1_800_000 ? "5–30m" : gap < 7_200_000 ? "30m–2h" : ">=2h"]++;
  }
  gaps.sort((a, b) => a - b);
  const compactions = await store.getContextCompactions(thread.threadId);
  results.push({ threadId: thread.threadId, messages: messages.length, ordinaryUsers: users.length,
    timedUsers: users.filter(message => Number.isFinite(at(message))).length,
    gaps: { samples: gaps.length, missingPairs, backwardsPairs, medianMs: percentile(gaps, 0.5), p90Ms: percentile(gaps, 0.9), buckets },
    usage: { retained: calls.length, dropped: journal?.modelUsage?.droppedCount ?? null, purposes },
    compactions: compactions.length, latestCompaction: compactions.at(-1)?.metrics ?? null });
}
results.sort((a, b) => b.messages - a.messages);
console.log(JSON.stringify({ capturedAt: new Date().toISOString(), threads: results.length,
  messages: results.reduce((n, item) => n + item.messages, 0), main: results[0],
  unavailable: ["historical provider-input segment hashes/bytes", "fixed-prefix actual tokens", "time to first reply"] }, null, 2));
