import assert from "node:assert/strict";

// Real production workspace and browser controller; fixture inference stays outside
// this UI journey. No synthetic wheel, forced inspector opening or API write.
export async function proveActorScroll({ controller, page, expected }) {
  const observe = async () => {
    if (!expected) return controller.observe();
    const captured = await controller.observeCurrent(expected);
    assert.ok(captured?.observation, "working Current remains observable without following another view");
    return captured.observation;
  };
  const scroll = { kind: "scroll", ref: "", value: "down" };
  const closed = async () => {
    if (await page.locator("#closeInspector").isVisible()) {
      const view = await observe();
      const close = view.controls.find(control => control.name === "Close node details");
      assert.ok(close, "the close control is visible in the actor observation");
      // Use production dispatch settlement before measuring later non-dispatch.
      // A raw fixture click can leave its own deferred focus events in flight.
      await controller.act({ kind: "click", ref: close.ref });
    }
    await page.locator("#inspectorContent").waitFor({ state: "hidden" });
  };
  const rejectsWithoutInput = async (action = scroll) => {
    const before = await page.evaluate(() => window.__taskActorInputEvidence.checkpoint());
    await assert.rejects(controller.act(action), {
      code: "actor_control_unavailable", actionDispatched: false,
    });
    assert.equal(await page.evaluate(() => window.__taskActorInputEvidence.checkpoint()), before);
  };
  await closed();
  const hidden = await observe();
  assert.equal(hidden.availableActions.includes("scroll"), false, "closed details do not offer scroll");
  await rejectsWithoutInput();

  const label = await page.locator(".graph-node").first().getAttribute("aria-label");
  const node = hidden.controls.find(control => control.name === label);
  assert.ok(node, "node is visible in the actor's actual control observation");
  await controller.act({ kind: "click", ref: node.ref });
  const originalViewport = page.viewportSize();
  const metrics = () => page.locator("#inspectorContent").evaluate(element => ({ top: element.scrollTop, remaining: element.scrollHeight - element.clientHeight - element.scrollTop, overflow: element.scrollHeight - element.clientHeight }));
  await page.evaluate(() => {
    window.__actorScrollProof = { trusted: 0, inDetails: 0 };
    window.__actorScrollListener = event => {
      if (event.isTrusted) window.__actorScrollProof.trusted++;
      if (event.composedPath().some(element => element.id === "inspectorContent")) window.__actorScrollProof.inDetails++;
    };
    window.addEventListener("wheel", window.__actorScrollListener, true);
  });
  try {
    // Resize the real workspace, keeping its accepted content and DOM untouched.
    await page.setViewportSize({ width: originalViewport.width, height: 1600 });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.ok((await metrics()).overflow <= 1, "the short accepted detail fits the tall viewport");
    assert.equal((await observe()).availableActions.includes("scroll"), false);
    await rejectsWithoutInput();
    for (const height of [500, 350, 250, 180]) {
      await page.setViewportSize({ width: originalViewport.width, height });
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      if ((await metrics()).overflow > 1) break;
    }
    assert.ok((await metrics()).overflow > 1, "the same real content overflows the smaller inspector");
    assert.equal((await observe()).availableActions.includes("scroll"), true);
    await rejectsWithoutInput({ kind: "scroll", ref: "", value: "up" });
    await controller.act(scroll);
    await page.waitForFunction(() => document.querySelector("#inspectorContent").scrollTop > 0);
    assert.deepEqual(await page.evaluate(() => window.__actorScrollProof), { trusted: 1, inDetails: 1 });
    for (let n = 0; n < 10 && (await metrics()).remaining > 1; n++) await controller.act(scroll);
    assert.ok((await metrics()).remaining <= 1, "trusted wheels reach the actual lower boundary");
    await rejectsWithoutInput();
    const bottom = (await metrics()).top;
    await controller.act({ kind: "scroll", ref: "", value: "up" });
    await page.waitForFunction(prior => document.querySelector("#inspectorContent").scrollTop < prior, bottom);
  } finally {
    await page.setViewportSize(originalViewport);
    await page.evaluate(() => {
      window.removeEventListener("wheel", window.__actorScrollListener, true);
      delete window.__actorScrollListener; delete window.__actorScrollProof;
    });
  }
  // The action was available in `visible`, then the real close control changed
  // the UI before dispatch. Refusal must not send hover/wheel or replay input.
  await closed();
  await rejectsWithoutInput();
  assert.equal((await observe()).availableActions.includes("scroll"), false);
  console.log(`PASS ${expected ? "working" : "settled"} actor scroll: hidden/short availability, real overflow movement, directional boundaries and closed-panel nondispatch`);
}
