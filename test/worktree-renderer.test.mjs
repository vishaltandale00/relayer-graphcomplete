import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("renders ordinary folder, loading, failure and Git choices in the production composer", async () => {
  vi.resetModules();
  const window = new Window({ url: "file:///relayer/index.html" });
  window.document.write(await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"));
  let resolveInspection;
  window.relayerDesktop = { worktrees: { inspect: vi.fn(() => new Promise((resolve) => { resolveInspection = resolve; })) } };
  for (const key of ["window", "document", "location", "localStorage"]) vi.stubGlobal(key, key === "window" ? window : window[key]);
  const { checkoutController, initializeCheckout } = await import("../desktop/renderer/src/checkout.js");
  initializeCheckout({ onAvailabilityChanged: () => {}, onScopeChanged: () => {} });
  const select = checkoutController.select({ path: "/repo", kind: "folder" });
  const control = window.document.querySelector("#checkoutControl");
  expect(control.classList.contains("hidden")).toBe(false);
  expect(window.document.querySelector("#checkoutLabel").textContent).toBe("");
  expect(window.document.querySelector("#checkoutStatus").classList.contains("checkout-spinner")).toBe(true);
  expect(window.document.querySelector("#checkoutButton").disabled).toBe(true);
  expect(checkoutController.ready).toBe(false);
  resolveInspection({ git: false, path: "/repo" }); await select;
  expect(control.classList.contains("hidden")).toBe(true);
  window.relayerDesktop.worktrees.inspect.mockRejectedValueOnce(new Error("Unavailable Git"));
  await checkoutController.select({ path: "/repo" });
  expect(window.document.querySelector("#retryCheckoutNotice")).not.toBeNull();
  expect(checkoutController.ready).toBe(false);
  window.relayerDesktop.worktrees.inspect.mockResolvedValueOnce({ git: true, branch: "main", commit: "aaa", repositoryId: "id", checkoutRoot: "/repo", relativePath: "", bases: [{ ref: "refs/remotes/origin/main", name: "origin/main", commit: "aaa", remote: true }, { ref: "checkout", name: "Checkout", commit: "aaa" }, ...Array.from({ length: 100 }, (_, index) => ({ ref: `refs/heads/feature-${index}`, name: `feature-${index}`, commit: "aaa" }))], defaultBase: "refs/remotes/origin/main", worktrees: [{ path: "/repo", branch: "main", exists: true, accessible: true }] });
  await checkoutController.select({ path: "/repo" });
  expect(window.document.querySelector("#checkoutLabel").textContent).toBe("Checkout");
  window.document.querySelector("#checkoutButton").click();
  window.document.querySelector("#newWorktree").focus();
  window.document.querySelector("#newWorktree").click();
  // Opening the base immediately must retain focus when draft persistence settles.
  window.document.querySelector("#worktreeBaseButton").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(window.document.activeElement.id).toBe("worktreeBaseSearch");
  window.document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  window.document.querySelector("#newThreadPrompt").focus();
  expect(window.document.querySelector("#checkoutMenu").classList.contains("hidden")).toBe(false);
  const menu = window.document.querySelector("#checkoutMenu");
  const list = menu.querySelector('.checkout-list[role="group"][aria-label="Registered checkouts"]');
  expect(list.tabIndex).toBe(0);
  expect(list.querySelector("[data-checkout-index]")).not.toBeNull();
  expect(list.contains(menu.querySelector("#newWorktree"))).toBe(false);
  expect(list.contains(menu.querySelector("#worktreeBase"))).toBe(false);
  expect(menu.querySelector("#newWorktree").checked).toBe(true);
  expect(menu.querySelector("#worktreeBase").value).toBe("refs/remotes/origin/main");
  expect(window.document.activeElement.id).toBe("newThreadPrompt");
  expect(menu.querySelector("#worktreeBasePicker").classList.contains("hidden")).toBe(true);
  menu.querySelector("#worktreeBaseButton").click();
  const search = menu.querySelector("#worktreeBaseSearch");
  expect(window.document.activeElement).toBe(search);
  expect(search).not.toBeNull();
  const key = value => window.document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  const choices = Array.from(menu.querySelectorAll("[data-base-ref]"));
  key("ArrowDown"); expect(window.document.activeElement).toBe(choices[0]);
  key("ArrowUp"); expect(window.document.activeElement).toBe(choices.at(-1));
  search.focus(); key("ArrowUp"); expect(window.document.activeElement).toBe(choices.at(-1));
  key("Escape");
  expect(window.document.activeElement.id).toBe("worktreeBaseButton");
  expect(menu.classList.contains("hidden")).toBe(false);
  expect(menu.querySelector("#worktreeBaseButton").getAttribute("aria-expanded")).toBe("false");
  menu.querySelector("#worktreeBaseButton").click();
  expect(menu.querySelector("#worktreeBase").options.length).toBeLessThanOrEqual(23);
  search.value = "feature-99";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  const options = Array.from(menu.querySelector("#worktreeBase").options).map(option => option.value);
  expect(options).toContain("checkout");
  expect(options).toContain("refs/remotes/origin/main");
  expect(options).toContain("refs/heads/feature-99");
  expect(options).not.toContain("refs/heads/feature-1");
  expect(window.document.activeElement).toBe(search);
  expect(menu.querySelectorAll("[data-base-ref]")[0].dataset.baseRef).toBe("refs/remotes/origin/main");
  menu.querySelector('[data-base-ref="refs/heads/feature-99"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(checkoutController.state.scope.checkout.base).toBe("refs/heads/feature-99");
  expect(window.document.activeElement.id).toBe("newThreadPrompt");
  expect(window.document.querySelector("#newThreadPrompt")).not.toBeNull();
  window.relayerDesktop.worktrees.inspect.mockResolvedValueOnce({
    ...checkoutController.state.inspection, defaultBase: null,
  });
  await checkoutController.select({ path: "/repo" });
  window.document.querySelector("#checkoutButton").click();
  window.document.querySelector("#newWorktree").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(window.document.activeElement.id).toBe("worktreeBaseButton");
  expect(window.document.querySelector("#worktreeBasePicker").classList.contains("hidden")).toBe(true);
  window.document.querySelector("#worktreeBaseButton").click();
  expect(window.document.activeElement.id).toBe("worktreeBaseSearch");
  expect(checkoutController.state.scope.checkout.base).toBeNull();
  await expect(checkoutController.prepareSend()).rejects.toThrow("Choose an available base");
  window.happyDOM.abort();
});

it("uses Enter to create and start in the new checkout, retaining it when startup fails", async () => {
  vi.resetModules();
  const window = new Window({ url: "http://127.0.0.1:43123/" });
  window.document.write(await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"));
  const created = { workingDirectory: "/managed/repo", checkoutRoot: "/managed/repo", branch: "relayer/generated", commit: "aaa", commonDirectory: "/repo/.git" };
  const service = {
    inspect: vi.fn(async () => ({ git: true, branch: "main", commit: "aaa", repositoryId: "repo", checkoutRoot: "/repo", relativePath: "", bases: [{ ref: "checkout", name: "Checkout", commit: "aaa" }], defaultBase: "checkout", worktrees: [{ path: "/repo", branch: "main", exists: true, accessible: true }] })),
    plan: vi.fn(async input => input), create: vi.fn(async () => created),
    validateSelection: vi.fn(),
  };
  window.relayerDesktop = { worktrees: service };
  for (const key of ["window", "document", "location", "localStorage", "history"]) vi.stubGlobal(key, key === "window" ? window : window[key]);
  const submissions = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (String(url).endsWith("/api/threads") && options?.method === "POST") {
      submissions.push(JSON.parse(options.body));
      if (submissions.length === 1) throw new Error("Injected startup failure");
      return new Response(JSON.stringify({ id: 42, rootInteractionId: 84 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("Stop fixture after thread admission");
  }));
  const { checkoutController, initializeCheckout } = await import("../desktop/renderer/src/checkout.js");
  const { viewState } = await import("../desktop/renderer/src/state.js");
  const { createFirstThread } = await import("../desktop/renderer/src/threads.js");
  const { bindComposerKeydown } = await import("../desktop/renderer/src/product-workspace/workspace.js");
  initializeCheckout({ onAvailabilityChanged: () => {}, onScopeChanged: () => {} });
  viewState.selectedPermissionProfileId = "auto";
  viewState.selectedScope = { kind: "project", projectId: 1, label: "repo", path: "/repo" };
  await checkoutController.select(viewState.selectedScope);
  const prompt = window.document.querySelector("#newThreadPrompt");
  prompt.value = "Start the task";
  let pendingSend;
  bindComposerKeydown(prompt, () => {
    pendingSend = createFirstThread({ harnessId: "codex-basic", modelSelection: { familyId: 1, providerId: "codex", modelId: "fixture" } });
  });
  window.document.querySelector("#checkoutButton").click();
  window.document.querySelector("#newWorktree").focus();
  window.document.querySelector("#newWorktree").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(window.document.activeElement).toBe(prompt);
  window.document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await pendingSend;
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ workingDirectory: created.workingDirectory, initialMessage: "Start the task", permissionProfileId: "auto", expectedCheckout: { checkoutRoot: created.checkoutRoot, commit: "aaa" } });
  expect(prompt.value).toBe("Start the task");
  expect(checkoutController.state.scope.checkout.created).toEqual(created);
  const planId = checkoutController.state.scope.checkout.planId;
  prompt.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await pendingSend;
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(service.plan.mock.calls.map(([input]) => input.planId)).toEqual([planId, planId]);
  expect(service.validateSelection).not.toHaveBeenCalled();
  expect(viewState.currentThreadId).toBe(42);
  expect(prompt.value).toBe("");
  window.happyDOM.abort();
});
