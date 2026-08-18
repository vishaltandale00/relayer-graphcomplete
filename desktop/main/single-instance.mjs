function presentWindow(window) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function claimPrimaryDesktopInstance({ app, getWindow }) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }

  let presentationPending = false;
  const presentPrimaryWindow = () => {
    const window = getWindow();
    if (!window) {
      presentationPending = true;
      return false;
    }
    presentationPending = false;
    presentWindow(window);
    return true;
  };

  app.on("second-instance", presentPrimaryWindow);
  return {
    presentPrimaryWindow,
    presentPendingWindow() {
      return presentationPending && presentPrimaryWindow();
    },
  };
}
