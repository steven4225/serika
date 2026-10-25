import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./ui-kit/upstream/button.js";
import { cn } from "./ui-kit/upstream/utils.js";

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

