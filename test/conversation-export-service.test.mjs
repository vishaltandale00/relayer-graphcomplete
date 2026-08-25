import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  conversationExportFilename,
  createConversationExportService,
} from "../desktop/main/services/conversation-export.mjs";

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "relayer-conversation-export-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("desktop conversation export", () => {
  it("opens the native dialog before fetching and leaves cancellation side-effect free", async () => {
    const events = [];
    const exportConversation = vi.fn(async () => {
      events.push("fetch");
      return new Uint8Array();
    });
    const service = createConversationExportService({
      dialog: {
        showSaveDialog: vi.fn(async (_window, options) => {
          events.push("dialog");
          expect(options.defaultPath).toBe("relayer-conversation-7.jsonl");
          expect(options.filters).toEqual([{ name: "JSON Lines", extensions: ["jsonl"] }]);
          return { canceled: true, filePath: undefined };
        }),
      },
      getWindow: () => ({ id: "owner-window" }),
      exportConversation,
    });

    await expect(service.save(7)).resolves.toEqual({ status: "canceled" });
    expect(events).toEqual(["dialog"]);
    expect(exportConversation).not.toHaveBeenCalled();
  });

  it("writes a sibling permission-restricted temp file and atomically installs JSONL bytes", async () => {
    const directory = await temporaryDirectory();
    const destinationWithoutExtension = join(directory, "debug-conversation");
    const bytes = new TextEncoder().encode('{"recordType":"header"}\n');
    const exportConversation = vi.fn(async () => bytes);
    const service = createConversationExportService({
      dialog: {
        showSaveDialog: vi.fn(async () => ({
          canceled: false,
          filePath: destinationWithoutExtension,
        })),
      },
      getWindow: () => null,
      exportConversation,
      createTemporaryId: () => "fixed",
    });

    await expect(service.save(42)).resolves.toEqual({ status: "saved" });
    expect(exportConversation).toHaveBeenCalledWith(42);
    const destination = `${destinationWithoutExtension}.jsonl`;
    expect(await readFile(destination)).toEqual(Buffer.from(bytes));
    expect(await readdir(directory)).toEqual(["debug-conversation.jsonl"]);
    if (process.platform !== "win32") {
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
  });

  it("atomically replaces a confirmed existing regular destination with the new bytes", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "existing.jsonl");
    await writeFile(destination, "old complete export", { mode: 0o600 });
    const bytes = new TextEncoder().encode('{"recordType":"header","exportVersion":1}\n');
    const service = createConversationExportService({
      dialog: {
        showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: destination })),
      },
      getWindow: () => null,
      exportConversation: async () => bytes,
      createTemporaryId: () => "fixed",
    });

    await expect(service.save(8)).resolves.toEqual({ status: "saved" });
    expect(await readFile(destination)).toEqual(Buffer.from(bytes));
    expect(await readdir(directory)).toEqual(["existing.jsonl"]);
  });

  it("removes the temporary file when installation fails", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "occupied.jsonl");
    await mkdir(destination);
    const service = createConversationExportService({
      dialog: {
        showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: destination })),
      },
      getWindow: () => null,
      exportConversation: async () => new TextEncoder().encode("complete bytes"),
      createTemporaryId: () => "fixed",
    });

    await expect(service.save(9)).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["occupied.jsonl"]);
    expect((await stat(destination)).isDirectory()).toBe(true);
  });

  it("does not remove a pre-existing file on an exclusive temporary-name collision", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "debug.jsonl");
    const collision = join(directory, ".debug.jsonl.fixed.tmp");
    await writeFile(collision, "foreign file", { mode: 0o600 });
    const service = createConversationExportService({
      dialog: {
        showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: destination })),
      },
      getWindow: () => null,
      exportConversation: async () => new TextEncoder().encode("export bytes"),
      createTemporaryId: () => "fixed",
    });

    await expect(service.save(9)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(collision, "utf8")).toBe("foreign file");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives a safe filename only from a validated selected thread ID", () => {
    expect(conversationExportFilename(123)).toBe("relayer-conversation-123.jsonl");
    expect(() => conversationExportFilename(0)).toThrow("positive thread ID");
    expect(() => conversationExportFilename("123")).toThrow("positive thread ID");
  });
});
