export async function confirmManagedRuntimeQuit({
  installer,
  dialog,
  parent,
  fatal = false,
  reason = new DOMException("Relayer quit during managed runtime installation.", "AbortError"),
} = {}) {
  const active = installer.activeOperations();
  if (active.length === 0) return true;
  if (fatal) {
    await installer.cancelAll(reason);
    return true;
  }
  const options = {
    type: "warning",
    title: "Runtime download in progress",
    message: "Relayer is still downloading a provider runtime.",
    detail: "Quitting now will cancel the download. You can reconnect the provider later to try again.",
    buttons: ["Keep downloading", "Quit anyway"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (response !== 1) return false;
  await installer.cancelAll(reason);
  return true;
}
