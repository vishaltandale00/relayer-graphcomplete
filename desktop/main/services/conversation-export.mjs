import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function conversationExportFilename(threadId) {
  if (!Number.isSafeInteger(threadId) || threadId <= 0) {
    throw new Error("Conversation export requires a positive thread ID.");
  }
  return `relayer-conversation-${threadId}.jsonl`;
}

function jsonlDestination(path) {
  return path.toLowerCase().endsWith(".jsonl") ? path : `${path}.jsonl`;
}

export function createConversationExportService({
  dialog,
  getWindow,
  exportConversation,
  createTemporaryId = randomUUID,
}) {
  if (!dialog?.showSaveDialog) throw new Error("Conversation export requires Electron's save dialog.");
  if (typeof getWindow !== "function") throw new Error("Conversation export requires a window resolver.");
  if (typeof exportConversation !== "function") {
    throw new Error("Conversation export requires an authenticated product exporter.");
  }

  return Object.freeze({
    async save(threadId) {
      const defaultPath = conversationExportFilename(threadId);
      const selection = await dialog.showSaveDialog(getWindow(), {
        title: "Export conversation",
        defaultPath,
        buttonLabel: "Export",
        filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (selection.canceled || !selection.filePath) return { status: "canceled" };

      const destination = jsonlDestination(selection.filePath);
      const temporary = join(
        dirname(destination),
        `.${basename(destination)}.${createTemporaryId()}.tmp`,
      );
      let temporaryFile;
      let ownsTemporary = false;
      try {
        const bytes = await exportConversation(threadId);
        temporaryFile = await open(temporary, "wx", 0o600);
        ownsTemporary = true;
        await temporaryFile.writeFile(bytes);
        await temporaryFile.close();
        temporaryFile = undefined;
        await rename(temporary, destination);
        return { status: "saved" };
      } catch (error) {
        await temporaryFile?.close().catch(() => undefined);
        if (ownsTemporary) await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  });
}
