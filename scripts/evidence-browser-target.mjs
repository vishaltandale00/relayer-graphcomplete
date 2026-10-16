// Configure a blank target before starting a scene. Loading the scene while
// attaching CDP, then reloading it, can persist first-boot user actions twice.
export async function openEvidenceBrowserPage(browserEndpoint, url, {
  connect, request = fetch, width = 1280, forcedColors = false,
}) {
  const protocol = browserEndpoint.protocol === "wss:" ? "https:" : "http:";
  const response = await request(`${protocol}//${browserEndpoint.host}/json/new?about%3Ablank`, { method: "PUT" });
  const target = await response.json();
  const cdp = await connect(target.webSocketDebuggerUrl);
  try {
    await cdp.call("Runtime.enable");
    await cdp.call("Page.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    if (forcedColors) {
      await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    }
    await cdp.call("Page.navigate", { url });
    return cdp;
  } catch (error) {
    cdp.close();
    throw error;
  }
}
