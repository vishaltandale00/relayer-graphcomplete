export function createElectronWorkspaceDriver({
  getWindow,
  getProductSession,
  diagnosticBodyLength = 2_500,
  pollIntervalMs = 40,
}) {
  const sleep = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

  async function evaluate(expression) {
    return getWindow().webContents.executeJavaScript(expression);
  }

  async function productRequest(path, options = {}) {
    const productSession = getProductSession();
    const response = await fetch(new URL(path, productSession.origin), {
      ...options,
      headers: {
        Accept: "application/json",
        Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value?.error?.message || JSON.stringify(value));
    return value;
  }

  async function waitFor(label, check, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value;
      await sleep(pollIntervalMs);
    }
    const currentWindow = getWindow();
    const diagnostic = currentWindow && !currentWindow.isDestroyed()
      ? await currentWindow.webContents.executeJavaScript(`({
        url: location.href,
        activeElement: document.activeElement?.id,
        toast: document.querySelector('#toast')?.textContent,
        body: document.body?.innerText?.slice(0, ${diagnosticBodyLength}),
      })`).catch(() => null)
      : null;
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
  }

  async function waitForPaint() {
    await evaluate(`new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)))`);
  }

  async function click(selector) {
    const clicked = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) return false;
      element.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Cannot click ${selector}.`);
  }

  async function clickNode(title) {
    const clicked = await evaluate(`(() => {
      const node = [...document.querySelectorAll('.graph-node')]
        .find((candidate) => candidate.querySelector('b')?.textContent === ${JSON.stringify(title)});
      node?.click();
      return Boolean(node);
    })()`);
    if (!clicked) throw new Error(`Cannot find graph node ${title}.`);
  }

  async function setValue(selector, value) {
    const updated = await evaluate(`(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      if (!field) return false;
      field.value = ${JSON.stringify(value)};
      field.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: ${JSON.stringify(value)},
      }));
      field.focus();
      return true;
    })()`);
    if (!updated) throw new Error(`Cannot update ${selector}.`);
  }

  async function waitForAcceptedInteractions(threadId, count) {
    let latest;
    try {
      return await waitFor(`${count} accepted interactions`, async () => {
        latest = await productRequest(`/api/threads/${threadId}`);
        return latest.interactions.length === count
          && latest.interactions.every((interaction) => interaction.completionStatus === "accepted")
          ? latest
          : false;
      }, 30_000);
    } catch (error) {
      throw new Error(`${error.message}; latest thread=${JSON.stringify(latest)}`, { cause: error });
    }
  }

  return Object.freeze({
    click,
    clickNode,
    evaluate,
    productRequest,
    setValue,
    sleep,
    waitFor,
    waitForAcceptedInteractions,
    waitForPaint,
  });
}
