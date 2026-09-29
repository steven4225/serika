import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { presentShellExec } from "./shell-result.js";

describe("presentShellExec", () => {
  it("does not treat truncated output as a command failure", () => {
    const shown = presentShellExec({
      ok: true, exitCode: 0, termination: "exited", signal: null,
      cancelled: false, timedOut: false, output: "hello", truncated: true,
    });
    assert.equal(shown?.status, "ok");
    assert.equal(shown?.truncated, true);
    assert.equal(shown?.detail, "exit 0");
  });

  it("surfaces Shell timeout separately from a generic tool failure", () => {
    const shown = presentShellExec({
      ok: true, exitCode: null, termination: "signalled", signal: "SIGTERM",
      cancelled: false, timedOut: true, output: "", truncated: false,
    });
    assert.equal(shown?.status, "timed_out");
    assert.equal(shown?.timedOut, true);
    assert.match(shown?.detail ?? "", /Shell 超时/);
  });

  it("surfaces a cancelled command without calling it a successful receipt", () => {
    const shown = presentShellExec({
      ok: true, exitCode: null, termination: "signalled", signal: "SIGTERM",
      cancelled: true, timedOut: false, output: "partial", truncated: false,
    });
    assert.equal(shown?.status, "cancelled");
    assert.equal(shown?.cancelled, true);
  });

  it("uses a non-zero exit code as failure when the command was not timed out or cancelled", () => {
    const shown = presentShellExec({
      ok: true, exitCode: 2, termination: "exited", signal: null,
      cancelled: false, timedOut: false, output: "nope", truncated: false,
    });
    assert.equal(shown?.status, "failed");
    assert.equal(shown?.exitCode, 2);
  });

  it("ignores unrelated tool payloads", () => {
    assert.equal(presentShellExec({ ok: true, text: "wrote" }), undefined);
  });
});
