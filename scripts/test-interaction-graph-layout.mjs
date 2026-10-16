import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, process.env.RELAYER_LAYOUT_EVIDENCE ?? ".relayer/evidence/interaction-graph-layout");
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, "http://localhost").pathname}`);
    if (!path.startsWith(root)) throw new Error("Outside fixture root");
    let body = await readFile(path);
    if (path.endsWith("/desktop/renderer/index.html")) body = body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace("</body>", '<script type="module" src="/scripts/fixtures/interaction-graph-layout.js"></script></body>');
    response.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[extname(path)] ?? "application/octet-stream");
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/desktop/renderer/index.html`;
if (process.argv.includes("--serve")) { console.log(`Production renderer fixture: ${url}`); await new Promise(() => {}); }
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url);
  await page.waitForFunction(() => Boolean(globalThis.layoutWorkspace));
  const check = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      const viewport = document.querySelector('.interaction-graph-viewport');
      return { panel: rect('#turnPopover'), heading: rect('.interaction-graph-heading'), picker: rect('#turnPicker'), banner: rect('#interactionBanner'), card: rect('.interaction-graph-node'), scrollLeft: viewport.scrollLeft, scrollWidth: viewport.scrollWidth, clientWidth: viewport.clientWidth, window: { width: innerWidth, height: innerHeight } };
    });
    console.log(JSON.stringify({ name, ...bounds }));
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    assert.ok(bounds.panel.x >= bounds.banner.left, `${name}: panel crosses banner left: ${bounds.panel.x}`);
    assert.ok(bounds.panel.right <= bounds.window.width, `${name}: panel crosses right viewport edge`);
    assert.ok(bounds.panel.bottom <= bounds.window.height - 11, `${name}: panel crosses bottom: ${bounds.panel.bottom}`);
    assert.equal(bounds.card.width, 192, `${name}: cards retain width`);
    assert.equal(Math.round(bounds.panel.right), Math.round(bounds.picker.right), `${name}: retain trigger alignment`);
    assert.ok(bounds.panel.top >= 0, `${name}: panel moved above window`);
    assert.ok(bounds.heading.left >= 0, `${name}: heading clipped`);
    return bounds;
  };
  assert.equal(await page.locator('#turnPopover').isVisible(), false);
  await page.locator('#turnPickerButton').click();
  await check('collapsed-1280');
  await page.evaluate(() => document.body.classList.remove('sidebar-collapsed'));
  await check('expanded-1280');
  for (const [width, height] of [[1800, 900], [1102, 800], [900, 600], [600, 500], [390, 320]]) {
    await page.setViewportSize({ width, height });
    const bounds = await check(`viewport-${width}-${height}`);
    if (width === 390) {
      assert.ok(bounds.scrollWidth > bounds.clientWidth, 'Narrow graph scrolls internally');
      const beforeRefresh = await page.locator('.interaction-graph-viewport').evaluate(element => {
        element.scrollLeft = 40;
        return element.scrollLeft;
      });
      assert.ok(beforeRefresh > 0, 'Scroll regression fixture has real horizontal overflow');
      const focusedTurn = await page.evaluate(() => document.activeElement.dataset.turnId);
      assert.equal(focusedTurn, '5', 'Selected interaction is focused before reconciliation');
      await page.evaluate(() => { for (let i = 0; i < 3; i++) layoutWorkspace.render(); });
      assert.equal(await page.locator('.interaction-graph-viewport').evaluate(element => element.scrollLeft), beforeRefresh, 'Repeated reconciliation preserves horizontal scroll');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.turnId), focusedTurn, 'Reconciliation retains focused interaction');
      await page.locator('.interaction-graph-node[data-turn-id="6"]').click();
      assert.equal(await page.locator('#turnPopover').isVisible(), false);
      assert.equal(await page.evaluate(() => layoutFixture.selection.currentInteractionId), 6);
      await page.locator('#turnPickerButton').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#turnPickerButton').evaluate(element => element === document.activeElement), true);
      await page.locator('#turnPickerButton').click();
    }
  }
  await page.setViewportSize({ width: 1280, height: 320 });
  await check('short-1280');
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await check('short-light');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const first = layoutFixture.turns[0];
    first.text = "Why does the sky look blue during the day, while sunsets change through orange and red? Explain what happens to the light.";
    for (let id = 7; id <= 14; id++) layoutFixture.turns.push({ ...first, id, graphNodeId: id * 10, text: `Sky follow-up ${id}` });
    layoutFixture.selection.currentInteractionId = 14;
    layoutFixture.state.currentInteractionId = 14;
    layoutWorkspace.render();
  });
  await page.locator('#turnPickerButton').click();
  await check('tall-selected-last');
  const scrolling = await page.locator('.interaction-graph-viewport').evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, extent: element.scrollHeight }));
  assert.ok(scrolling.extent > scrolling.height && scrolling.top > 0, 'Last selected card must be reached through vertical graph scrolling');
  const last = await page.locator('.interaction-graph-node[data-turn-id="14"]').boundingBox();
  const viewport = await page.locator('.interaction-graph-viewport').boundingBox();
  assert.ok(last.y >= viewport.y && last.y + last.height <= viewport.y + viewport.height + 1, 'Selected last card is fully visible');
  // Background state reconciliation must not undo the reader's scroll gesture.
  await page.locator('.interaction-graph-viewport').evaluate(element => { element.scrollTop = 0; });
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await page.mouse.wheel(0, 80);
  await page.waitForFunction(() => document.querySelector('.interaction-graph-viewport').scrollTop > 0);
  const beforeRefresh = await page.locator('.interaction-graph-viewport').evaluate(element => element.scrollTop);
  assert.ok(beforeRefresh > 0, 'Scroll regression fixture has real vertical overflow');
  await page.evaluate(() => {
    layoutFixture.turns[1].completionStatus = 'running';
    layoutWorkspace.render();
  });
  const afterRefresh = await page.locator('.interaction-graph-viewport').evaluate(element => element.scrollTop);
  console.log(JSON.stringify({ name: 'scroll-after-reconciliation', beforeRefresh, afterRefresh }));
  await page.screenshot({ path: resolve(output, 'scroll-after-reconciliation.png') });
  assert.equal(afterRefresh, beforeRefresh, 'Interaction graph preserves reader scroll during state reconciliation');
  await page.locator('.interaction-graph-node[data-turn-id="14"]').click();
  await page.evaluate(() => {
    layoutFixture.selection.currentInteractionId = 5;
    layoutFixture.state.currentInteractionId = 5;
    layoutFixture.turns[0].contexts = [{ targetNode: layoutFixture.state.nodes[0], annotations: [] }];
    layoutWorkspace.render();
  });
  await page.locator('#turnPickerButton').click();
  await check('wrapped-banner');
  await page.evaluate(() => {
    layoutFixture.turns[0].interactionGraph.sources.push({ interactionId: 99, threadId: 801, text: "Parent still working", completionStatus: "running", layers: [], invocationActionId: 99 });
    layoutWorkspace.render();
  });
  const activeOrigin = page.locator('.interaction-graph-node[data-turn-id="99"]');
  assert.equal(await activeOrigin.isDisabled(), true);
  await activeOrigin.evaluate(element => element.click());
  assert.equal(await page.evaluate(() => layoutFixture.selection.currentInteractionId), 5);
  assert.equal(await page.locator('#turnPopover').isVisible(), true);
  await activeOrigin.scrollIntoViewIfNeeded();
  await check('active-origin-light');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await check('active-origin-dark');
  await page.keyboard.press('Escape');
  await page.locator('#interactionContextPill').click();
  const contextBounds = () => page.locator('#interactionContextPopover').evaluate(element => ({ x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y, width: element.getBoundingClientRect().width, pickerPosition: getComputedStyle(document.querySelector('#turnPicker')).position }));
  const gatedContext = await contextBounds();
  assert.equal(gatedContext.pickerPosition, 'relative');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { for (const turn of layoutFixture.turns) delete turn.interactionGraph; layoutWorkspace.render(); });
  await page.locator('#interactionContextPill').click();
  const legacyContext = await contextBounds();
  assert.equal(legacyContext.width, gatedContext.width);
  assert.equal(legacyContext.pickerPosition, 'relative');
  await page.keyboard.press('Escape');
  await page.locator('#turnPickerButton').click();
  const legacy = await page.locator('#turnPopover').evaluate(element => ({ width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right, pickerRight: document.querySelector('#turnPicker').getBoundingClientRect().right, graph: element.classList.contains('interaction-graph-popover') }));
  assert.deepEqual(legacy, { width: 320, right: legacy.pickerRight, pickerRight: legacy.pickerRight, graph: false });
  await page.evaluate(() => layoutWorkspace.dispose());
  console.log('PASS: graph bounds, resize/sidebar, scrolling/selection, dismissal, light theme, disabled active origin, legacy placement');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
