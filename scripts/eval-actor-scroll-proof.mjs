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
  const rejectsWithoutInput = async () => {
    const before = await page.evaluate(() => window.__taskActorInputEvidence.checkpoint());
    await assert.rejects(controller.act(scroll), {
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
  const visible = await observe();
  assert.equal(visible.availableActions.includes("scroll"), true, "visible details offer scroll");
  await page.evaluate(() => {
    window.__actorScrollProof = { trusted: 0, inDetails: 0 };
    window.__actorScrollListener = event => {
      if (event.isTrusted) window.__actorScrollProof.trusted++;
      if (event.composedPath().some(element => element.id === "inspectorContent")) window.__actorScrollProof.inDetails++;
    };
    window.addEventListener("wheel", window.__actorScrollListener, true);
  });
  try {
    await controller.act(scroll);
    assert.deepEqual(await page.evaluate(() => window.__actorScrollProof), { trusted: 1, inDetails: 1 });
  } finally {
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
  console.log(`PASS ${expected ? "working" : "settled"} actor scroll: hidden availability, trusted visible-detail wheel and closed-panel nondispatch`);
}
