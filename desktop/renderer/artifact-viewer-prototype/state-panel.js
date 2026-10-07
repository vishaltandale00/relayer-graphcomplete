// PROTOTYPE — throwaway (issue #684). Shows the full prototype state on demand.
export function mountStatePanel(readState) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "proto-state-button";
  button.textContent = "State";
  const panel = document.createElement("aside");
  panel.className = "proto-state-panel";
  panel.hidden = true;
  const pre = document.createElement("pre");
  panel.append(pre);
  let timer = null;
  const refresh = async () => {
    const state = readState();
    try { state.processes = await (await fetch("/proto/processes")).json(); } catch {}
    pre.textContent = JSON.stringify(state, null, 2);
  };
  button.onclick = () => {
    panel.hidden = !panel.hidden;
    clearInterval(timer);
    if (!panel.hidden) { refresh(); timer = setInterval(refresh, 1000); }
  };
  document.body.append(button, panel);
}
