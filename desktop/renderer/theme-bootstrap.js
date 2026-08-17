(() => {
  const saved = localStorage.getItem("relayerAppearance");
  document.documentElement.dataset.theme = saved === "light" ? "light" : "dark";
})();
