import assert from "node:assert/strict";
import { test } from "node:test";
import { registerTaskResultScheme } from "./mac-launcher.mjs";

test("local launcher registers task-result scheme once and does not replace another registration", () => {
  const commands = [];
  const run = (_file, args) => {
    commands.push(args[1]);
    if (args[1].startsWith("Print")) throw new Error("missing key");
    return "";
  };
  assert.equal(registerTaskResultScheme("/fixture/Info.plist", run), true);
  assert.ok(commands.includes("Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string serika"));
  assert.equal(registerTaskResultScheme("/fixture/Info.plist", () => "serika\n"), false);
  assert.throws(() => registerTaskResultScheme("/fixture/Info.plist", () => "another-app\n"), /unexpected/);
  assert.throws(() => registerTaskResultScheme("/fixture/Info.plist", (_file, args) => {
    if (args[1].includes("URLSchemes:0")) throw new Error("missing");
    return "existing URLTypes";
  }), /incomplete/);
});
