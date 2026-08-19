import { afterEach, describe, expect, it } from "vitest";

const globalNames = ["document", "location", "window"];
const originalGlobals = new Map(
  globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

afterEach(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

describe("Eval review sidebar", () => {
  it("keeps the complete named thread list visible across rerenders", async () => {
    const classList = () => {
      const values = new Set();
      return {
        add: (...names) => names.forEach((name) => values.add(name)),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        contains: (name) => values.has(name),
      };
    };
    const chatLabel = { textContent: "Chats" };
    const projectLabel = { textContent: "Projects" };
    const chatSection = {
      classList: classList(),
      querySelector: (selector) => selector === ".section-label" ? chatLabel : null,
    };
    const projectSection = { classList: classList() };
    const injectedCaseLabel = { closest: () => chatSection };
    let caseLabelsInjected = false;
    const chatList = {
      value: "",
      closest: () => chatSection,
      get innerHTML() { return this.value; },
      set innerHTML(value) {
        this.value = value;
        caseLabelsInjected = true;
      },
    };
    const elements = new Map([
      [".sidebar-title strong", { textContent: "Relayer" }],
      ["#newThread", { classList: classList() }],
      ["#chatList", chatList],
      ["#projectList", { closest: () => projectSection }],
      ["#settingsButton", { classList: classList() }],
    ]);
    Object.assign(globalThis, {
      location: new URL("http://127.0.0.1:43123/?review=1"),
      window: { relayerDesktop: undefined, relayerEvalReview: undefined },
      document: {
        querySelector: (selector) => elements.get(selector) || null,
        querySelectorAll: (selector) => selector === ".section-label"
          ? caseLabelsInjected
            ? [chatLabel, injectedCaseLabel, projectLabel]
            : [chatLabel, projectLabel]
          : [],
        createElement: () => ({
          innerHTML: "",
          set textContent(value) {
            this.innerHTML = String(value)
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;");
          },
        }),
      },
    });

    const { renderSidebar } = await import("../desktop/renderer/src/navigation.js");
    const { viewState } = await import("../desktop/renderer/src/state.js");
    viewState.currentThreadId = "diagnosis-thread";
    viewState.evalContext = {
      harnessConfigurationName: "codex-basic-high",
      cases: [{
        name: "h3 · status-code sanitization",
        status: "failed",
        threads: [
          { id: "architecture-thread", name: "Architecture question" },
          { id: "diagnosis-thread", name: "Read-only bug diagnosis" },
          { id: "implementation-thread", name: "Implement and commit the repair" },
        ],
      }],
    };

    renderSidebar();
    renderSidebar();

    expect(chatSection.classList.contains("hidden")).toBe(false);
    expect(projectSection.classList.contains("hidden")).toBe(true);
    expect(chatLabel.textContent).toBe("Cases · codex-basic-high");
    expect(chatList.innerHTML).toContain("Architecture question");
    expect(chatList.innerHTML).toContain("Read-only bug diagnosis");
    expect(chatList.innerHTML).toContain("Implement and commit the repair");
    expect(chatList.innerHTML).toContain('class="entry active" data-thread="diagnosis-thread"');
    expect(chatList.innerHTML).not.toContain("Thread 1");
  });
});
