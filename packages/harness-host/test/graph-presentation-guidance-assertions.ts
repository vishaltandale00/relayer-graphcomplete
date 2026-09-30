import { expect } from "vitest";

export function expectGraphPresentationGuidance(prompt: string): void {
  expect(prompt).toContain("You choose the flow of each query");
  expect(prompt).toContain("No node count, recursive-call quota, or update schedule is required");
  expect(prompt).toContain("Question lifecycle:");
  if (prompt.includes("Python capability reference")) {
    expect(prompt).not.toContain("JavaScript capability reference");
    expect(prompt).toContain("interaction.submitted_inputs");
    expect(prompt).toContain("action_capability(key, action)");
  } else {
    expect(prompt).toContain("JavaScript capability reference");
    expect(prompt).not.toContain("Python capability reference");
    expect(prompt).toContain("input.submittedInputs");
    expect(prompt).toContain("detailCapability.expand(key, action)");
  }
  expect(prompt).toContain("Build and validate in small increments");
  expect(prompt).toContain("not a required query flow or publication schedule");
  expect(prompt).toContain("does not await future answers");
  expect(prompt).toContain("border-collapse and cursor are unsupported");
  expect(prompt).toContain("register ALL actions");
  expect(prompt).toContain("It is not a draft preview");
  expect(prompt).toContain('"cssProperties":["align-content"');
  expect(prompt).toContain("Valid node icons: choose the content icon that names what the node is about");
  expect(prompt).toContain("- Reasoning, ideas and process: bolt, brain, compass, palette, route, search");
  expect(prompt).toMatch(/Signal icons have no colour[^\n]*: alert-circle, [^\n]*\binfo\b/);
  expect(prompt).toContain('Theme authoring: design readable light AND dark');
  expect(prompt).toContain('[data-relayer-theme="light"]');
  expect(prompt).toContain('[data-relayer-theme="dark"]');
  expect(prompt).toContain('guidance, not mandatory colors or a layout recipe');
  expect(prompt).toContain('do not create duplicate inputs');
  expect(prompt).toContain('bind both variants as ordinary assets/content');
  expect(prompt).toContain("Available presentation capabilities:");
  expect(prompt).toContain("without image files");
  expect(prompt).toContain("native image inspection");
  expect(prompt).toContain("Each layer should explain its scope as a coherent whole");
  expect(prompt).toContain('Choose "expand" when another layer should deepen one part');
  expect(prompt).toContain('Choose "reference" for supporting evidence or reusable context');
  expect(prompt).toContain("A layer reached as a reference may author only further reference actions");
  expect(prompt).toContain('Choose "invoke" when the useful next step requires a new agent interaction');
  expect(prompt).toContain('choosing "stop" means leaving the node without a further action');
  expect(prompt).toContain("It is not GraphComplete's stopped lifecycle state");
}
