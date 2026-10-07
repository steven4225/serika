import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./zcode/upstream/button.js";
import { cn } from "./zcode/upstream/utils.js";
import { DesktopWindowFrame } from "./zcode/upstream/desktop-window-frame.js";
import { ZCodeSidebar } from "./zcode/sidebar.js";
import { APPEARANCE_KEY, zcodeAppearance } from "./zcode/appearance.js";

it("source button retains native disabled semantics and font/color utility groups", () => {
  const classes = cn("text-ui-base text-foreground px-2", "text-ui-caption px-3");
  assert.ok(classes.includes("text-ui-caption"));
  assert.ok(classes.includes("text-foreground"));
  assert.ok(!classes.includes("text-ui-base"));
  assert.ok(!classes.includes("px-2"));
  const markup = renderToStaticMarkup(createElement(Button, { disabled: true, size: "icon", variant: "ghost", "aria-label": "停止" }));
  assert.match(markup, /disabled=""/);
  assert.match(markup, /data-slot="button"/);
  assert.match(markup, /aria-label="停止"/);
});

it("source frame uses the native macOS surface without mounting an upstream service", () => {
  const markup = renderToStaticMarkup(createElement(DesktopWindowFrame, { title: "Serika", isDesktop: true, isMacDesktop: true, children: "host page" }));
  assert.match(markup, /data-desktop-window-frame="true"/);
  assert.match(markup, /bg-background-alt/);
  assert.match(markup, /host page/);
});

it("appearance is a presentation-only preference and the sidebar exposes its switch", () => {
  assert.equal(zcodeAppearance(null), "dark");
  assert.equal(zcodeAppearance("light"), "light");
  assert.equal(zcodeAppearance("invalid"), "dark");
  assert.equal(APPEARANCE_KEY, "serika:appearance");
  const markup = renderToStaticMarkup(createElement(ZCodeSidebar, {
    threads: [], currentId: "a", drafts: new Map(), workspaceRoot: "/isolated", loading: false,
    error: null, busy: false, selected: null, pendingMemory: null, unknownRuns: 0,
    onNew: () => {}, onSelect: () => {}, onOpen: () => {}, onConversation: () => {},
    appearance: "dark", onAppearance: () => {},
  }));
  assert.match(markup, /aria-label="切换浅色外观"/);
  assert.match(markup, /data-zcode-source="WorkspaceSidebar"/);
  assert.match(markup, /data-zcode-source="WorkspaceSidebarFooter"/);
  assert.doesNotMatch(markup, /账号|订阅权益|插件市场/);
});
