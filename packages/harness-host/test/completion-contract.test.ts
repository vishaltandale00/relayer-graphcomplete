import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompletionContract, InteractionInput, SubmittedInput } from "@relayer/graph-client";
import { validateCompletionContract } from "../src/completion-contract.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const map = value as Record<string, unknown>;
    return `{${Object.keys(map).sort().map(key => `${JSON.stringify(key)}:${canonical(map[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function preparedInput(): InteractionInput {
  const submittedInputs: SubmittedInput[] = [
    { action: { control: "text", prompt: "Destination" }, value: { text: "Lisbon" } },
    { action: { control: "single_select", prompt: "Season", options: [{ key: "spring", label: "Spring" }] }, value: { selected: [{ key: "spring", label: "Spring" }] } },
    { action: { control: "multi_select", prompt: "Interests", options: [{ key: "food", label: "Food" }] }, value: { selected: [{ key: "food", label: "Food" }] } },
  ];
  const sealed: Omit<CompletionContract, "digest"> = {
    schemaVersion: 1, interactionNodeId: 29,
    input: { text: "Compare vacations", context: [], answers: submittedInputs.map(({ action, value }, index) => ({ sourceNodeId: 11, sourceActionId: index + 1, question: action, value })), invocationReferences: [] },
    authorities: [], returnRequirements: [],
  };
  return {
    completionContractStatus: "sealed",
    completionContract: { ...sealed, digest: `sha256:v1:${createHash("sha256").update(canonical(sealed)).digest("hex")}` },
    interaction: { id: 29, kind: "interaction", detail: "Compare vacations", icon: "", title: "Vacation", state: "accepted" },
    contexts: [], submittedInputs: [...submittedInputs].reverse(),
  };
}

describe("CompletionContract normalized answer projection", () => {
  it("accepts actual three-control semantic order without changing the sealed occurrence order", () => {
    const input = preparedInput();
    expect(() => validateCompletionContract(input, 29)).not.toThrow();
    expect(input.completionContract?.input.answers[0]?.question.control).toBe("text");
  });

  it.each(["changed", "missing", "duplicate"])("rejects %s normalized answers", (mode) => {
    const input = preparedInput();
    const entries = [...input.submittedInputs!];
    if (mode === "changed") entries[2] = { ...entries[2]!, value: { text: "Kyoto" } };
    if (mode === "missing") entries.pop();
    if (mode === "duplicate") entries[1] = entries[0]!;
    expect(() => validateCompletionContract({ ...input, submittedInputs: entries }, 29)).toThrow("normalized interaction input");
  });
});
