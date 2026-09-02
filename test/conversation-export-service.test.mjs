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
  it("derives the dialog filename from a validated thread ID and keeps cancellation side-effect free", async () => {
    expect(conversationExportFilename(123), "the filename derives from the thread ID")
      .toBe("relayer-conversation-123.jsonl");
    const invalidIds = [[0, "zero"], ["123", "a string"]];
    for (const [id, label] of invalidIds) {
      expect(() => conversationExportFilename(id), `${label} is not a thread ID`).toThrow("positive thread ID");
    }

    const events = [];
    const exportConversation = vi.fn(async () => {
      events.push("fetch");
      return new Uint8Array();
    });
    const service = createConversationExportService({
      dialog: {
        showSaveDialog: vi.fn(async (_window, options) => {
          events.push("dialog");
          expect.soft(options.defaultPath, "the default path matches the validated thread ID")
            .toBe("relayer-conversation-7.jsonl");
          expect.soft(options.filters, "the dialog offers JSON Lines only")
            .toEqual([{ name: "JSON Lines", extensions: ["jsonl"] }]);
          return { canceled: true, filePath: undefined };
        }),
      },
      getWindow: () => ({ id: "owner-window" }),
      exportConversation,
    });

    await expect(service.save(7), "cancellation resolves as canceled").resolves.toEqual({ status: "canceled" });
    expect(events, "the native dialog opens before any fetch").toEqual(["dialog"]);
    expect(exportConversation, "cancellation never fetches the conversation").not.toHaveBeenCalled();
  }, 15_000);

  it("installs export bytes atomically: fresh write, replacement, failure cleanup, collision guard", async () => {
    const freshDirectory = await temporaryDirectory();
    const destinationWithoutExtension = join(freshDirectory, "debug-conversation");
    const bytes = new TextEncoder().encode('{"recordType":"header"}\n');
    const exportConversation = vi.fn(async () => bytes);
    const freshService = createConversationExportService({
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

    await expect(freshService.save(42), "a fresh export saves").resolves.toEqual({ status: "saved" });
    expect(exportConversation, "the fetch names the selected thread").toHaveBeenCalledWith(42);
    const destination = `${destinationWithoutExtension}.jsonl`;
    expect(await readFile(destination), "the installed bytes").toEqual(Buffer.from(bytes));
    expect(await readdir(freshDirectory), "the sibling temp file is gone after install")
      .toEqual(["debug-conversation.jsonl"]);
    if (process.platform !== "win32") {
      expect((await stat(destination)).mode & 0o777, "the destination is owner-only").toBe(0o600);
    }

    const replacementDirectory = await temporaryDirectory();
    const replacementDestination = join(replacementDirectory, "existing.jsonl");
    await writeFile(replacementDestination, "old complete export", { mode: 0o600 });
    const replacementBytes = new TextEncoder().encode('{"recordType":"header","exportVersion":1}\n');
    const replacementService = createConversationExportService({
      dialog: {
        showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: replacementDestination })),
      },
      getWindow: () => null,
      exportConversation: async () => replacementBytes,
      createTemporaryId: () => "fixed",
    });

    await expect(replacementService.save(8), "a confirmed existing export is replaced").resolves.toEqual({ status: "saved" });
    expect(await readFile(replacementDestination), "the new bytes win").toEqual(Buffer.from(replacementBytes));
    expect(await readdir(replacementDirectory), "no litter around the replacement").toEqual(["existing.jsonl"]);

    const occupiedDirectory = await temporaryDirectory();
    const occupiedDestination = join(occupiedDirectory, "occupied.jsonl");
    await mkdir(occupiedDestination);
    const occupiedService = createConversationExportService({
      dialog: {
        showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: occupiedDestination })),
      },
      getWindow: () => null,
      exportConversation: async () => new TextEncoder().encode("complete bytes"),
      createTemporaryId: () => "fixed",
    });

    await expect(occupiedService.save(9), "a failed install rejects").rejects.toThrow();
    expect(await readdir(occupiedDirectory), "the temp file is removed when installation fails")
      .toEqual(["occupied.jsonl"]);
    expect((await stat(occupiedDestination)).isDirectory(), "the occupying directory survives untouched").toBe(true);

    const collisionDirectory = await temporaryDirectory();
    const collisionDestination = join(collisionDirectory, "debug.jsonl");
    const collision = join(collisionDirectory, ".debug.jsonl.fixed.tmp");
    await writeFile(collision, "foreign file", { mode: 0o600 });
    const collisionService = createConversationExportService({
      dialog: {
        showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: collisionDestination })),
      },
      getWindow: () => null,
      exportConversation: async () => new TextEncoder().encode("export bytes"),
      createTemporaryId: () => "fixed",
    });

    await expect(collisionService.save(9), "an exclusive temp-name collision rejects")
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(collision, "utf8"), "the foreign file survives the collision").toBe("foreign file");
    await expect(stat(collisionDestination), "no destination appears after the collision")
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});
