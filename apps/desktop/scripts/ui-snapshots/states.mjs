import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const pages = ["zcode-preview.html", "interaction-preview.html", "interaction-preview.html?tasks=1", "interaction-preview.html?brief=empty",
  "interaction-preview.html?brief=degraded", "interaction-preview.html?work-task-flow", "memory-preview.html"];
const nav = ["对话", "手札", "任务", "记忆", "搜索", "设置"];
const settings = ["连接应用", "文件与网页", "电脑控制", "技能", "Telegram", "通用", "记忆设置", "通知与后台", "快捷键", "高级", "关于"];
const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--no-sandbox"] });
const norm = html => html.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "ISO").replace(/\d{1,2}:\d{2}(:\d{2})?(\.\d+)?/g, "HH:MM").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "ISO").replace(/\?t=\d+/g, "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID");
let n = 0;
for (const url of pages) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on("pageerror", e => errs.push(String(e)));
  await p.goto((process.env.PREVIEW_URL ?? "http://127.0.0.1:5187") + "/" + url, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  const shot = async (name) => {
    const key = `${String(++n).padStart(3, "0")}-${url.replace(/[^a-z0-9]+/gi, "_")}-${name}`;
    writeFileSync(`${out}/${key}.html`, norm(await p.evaluate(() => document.body.innerHTML)));
    await p.screenshot({ path: `${out}/${key}.png` });
  };
  await shot("initial");
  for (const label of ["手札", "任务", "记忆", "设置", ...settings, "对话", "搜索"]) {
    if (settings.includes(label)) {
      const nav0 = p.locator(`button[aria-label="设置"]`).first();
      if (await nav0.count()) { try { await nav0.click({ timeout: 2000 }); await p.waitForTimeout(300); } catch {} }
      const s = p.locator("button", { hasText: label }).first();
      if (!(await s.count())) continue;
      try { await s.click({ timeout: 2000 }); } catch { continue; }
    } else {
      const loc = p.locator(`button[aria-label="${label}"], [role=tab][aria-label="${label}"]`).first();
      const alt = p.getByRole("button", { name: label, exact: true }).first();
      const t = (await loc.count()) ? loc : alt;
      if (!(await t.count())) continue;
      try { await t.click({ timeout: 2000 }); } catch { continue; }
      if (label === "设置") { /* stay */ }
    }
    await p.waitForTimeout(700);
    await shot(label);
  }
  if (url === "zcode-preview.html" || url === "interaction-preview.html") {
    await p.goto((process.env.PREVIEW_URL ?? "http://127.0.0.1:5187") + "/" + url, { waitUntil: "networkidle" });
    await p.waitForTimeout(1200);
    const box = p.locator("textarea").first();
    if (await box.count()) {
      await box.fill("帮我读一下 notes/work-plan.md");
      await p.locator(`button[aria-label="发送消息"]`).first().click({ timeout: 2000 }).catch(() => {});
      await p.waitForTimeout(1500);
      await shot("sent");
      const allow = p.getByRole("button", { name: /^允许/ }).first();
      if (await allow.count()) { await allow.click({ timeout: 2000 }).catch(() => {}); await p.waitForTimeout(1500); await shot("allowed"); }
    }
    const collapse = p.locator(`button[aria-label="收起侧栏"]`).first();
    if (await collapse.count()) { await collapse.click({ timeout: 2000 }).catch(() => {}); await p.waitForTimeout(600); await shot("collapsed"); }
    const expand = p.locator(`button[aria-label="展开侧栏"]`).first();
    if (await expand.count()) { await expand.click({ timeout: 2000 }).catch(() => {}); await p.waitForTimeout(600); await shot("expanded"); }
    await p.setViewportSize({ width: 700, height: 900 }); await p.waitForTimeout(800); await shot("compact");
    const today = p.getByRole("button", { name: /^手札/ }).first();
    if (await today.count()) { await today.click({ timeout: 2000 }).catch(() => {}); await p.waitForTimeout(600); await shot("compact-dashboard"); }
    await p.setViewportSize({ width: 1440, height: 900 }); await p.waitForTimeout(800); await shot("wide-again");
  }
  writeFileSync(`${out}/errors-${url.replace(/[^a-z0-9]+/gi, "_")}.txt`, errs.join("\n"));
  await p.close();
}
await b.close(); process.exit(0);
