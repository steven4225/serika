import assert from "node:assert/strict";
import { test } from "node:test";
import { statedEverydayPreference, statedScenario } from "./memory-observation-policy.js";

test("everyday source probes accept literal self/scene/value evidence, not inferred synonyms or broadened qualifiers", () => {
  for (const text of ["我的饮食辣度是微辣。", "从现在起，我的饮食辣度改成微辣。", "仅在当前对话里，我的饮食辣度是微辣。", "在「工作日早餐」场景，我的饮食辣度是微辣。"])
    assert.deepEqual(statedEverydayPreference(text), { version: 2, subject: "user", attribute: "diet_spiciness", value: "mild" });
  assert.equal(statedScenario("在「工作日早餐」场景，我的饮食辣度是微辣。").scenario, "工作日早餐");
  for (const text of [
    "工作日早餐，我的饮食辣度是微辣。", "我的饮食辣度大概是微辣。", "我不太能吃辣。", "如果我的饮食辣度是微辣，就好了。",
    "我的朋友说我的饮食辣度是微辣。", "我的饮食辣度不是微辣。", "我的饮食辣度是微辣？", "下个月我的饮食辣度改成微辣。",
    "我建议我的饮食辣度改成微辣。", "我的饮食辣度是微辣，但尚未决定。", "我的饮食辣度是微辣；我的饮食辣度是不辣。",
    "不要把我的通知渠道改成Telegram。", "我的通知渠道是Telegram，但这只是举例。", "请启用Telegram并记住我的通知渠道是Telegram。",
  ]) assert.equal(statedEverydayPreference(text), undefined, text);
  assert.equal(statedEverydayPreference("我的通知渠道是Telegram。")?.value, "telegram");
  for (const text of ["用户的通知渠道是Telegram。", "仅在当前对话里，用户的通知渠道是 Telegram。", "用户的饮食辣度是微辣。"]) {
    assert.equal(statedEverydayPreference(text), undefined, "third-person saved wording cannot become a user source");
    assert.ok(statedEverydayPreference(text, "body"), text);
  }
  assert.equal(statedEverydayPreference("朋友的通知渠道是Telegram。", "body"), undefined);
  assert.equal(statedEverydayPreference("用户的通知渠道不是Telegram。", "body"), undefined);
});
