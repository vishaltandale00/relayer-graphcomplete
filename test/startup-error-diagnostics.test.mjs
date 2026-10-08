import { describe, expect, it } from "vitest";
import { captureStartupErrorDiagnostics, validStartupNetworkCode, validStartupStage } from "../desktop/main/services/startup-error-diagnostics.mjs";

describe("startup error diagnostics", () => {
  it("extracts the Chromium code and original approved application stack without raw loadURL data", () => {
    const error = new Error("ERR_FAILED (-2) loading 'http://127.0.0.1:58702/private-token'");
    error.stack = "Error: private\n    at load (C:\\Users\\private\\app\\desktop\\main\\index.mjs:413:7)\n    at vendor (/private/node_modules/vendor/index.mjs:1:2)";
    expect(captureStartupErrorDiagnostics(error)).toEqual({
      networkCode: "ERR_FAILED", frames: [{ module: "desktop/main/index.mjs", line: 413, column: 7 }],
    });
  });

  it("bounds cause inspection and tolerates cycles and throwing getters", () => {
    const cause = { code: "ERR_CONNECTION_REFUSED", stack: "Error\n    at load (/private/app/desktop/main/index.mjs:42:2)" };
    const error = { cause, get stack() { throw new Error("private"); }, get message() { throw new Error("private"); } };
    cause.cause = error;
    expect(captureStartupErrorDiagnostics(error)).toEqual({ networkCode: "ERR_CONNECTION_REFUSED", frames: [{ module: "desktop/main/index.mjs", line: 42, column: 2 }] });
    expect(captureStartupErrorDiagnostics({ cause: { cause: { cause: { cause: { code: "ERR_FAILED" } } } } })).toEqual({ networkCode: null, frames: [] });
  });

  it("omits unknown errors, arbitrary messages and invented application modules", () => {
    const diagnostics = captureStartupErrorDiagnostics({ code: "SECRET_NATIVE_ERROR", message: "private ERR_FAILED data", stack: "Error\n    at secret (/private/desktop/main/private-token.mjs:1:2)" });
    expect(diagnostics).toEqual({ networkCode: null, frames: [] });
    expect(validStartupNetworkCode("ERR_FAILED")).toBe(true);
    expect(validStartupNetworkCode("ECONNRESET")).toBe(true);
    expect(validStartupNetworkCode("private-code")).toBe(false);
    expect(validStartupStage("window-load")).toBe(true);
    expect(validStartupStage("private-stage")).toBe(false);
  });
});
