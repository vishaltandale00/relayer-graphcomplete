// PROTOTYPE — throwaway (issue #684). The one shared chat draft: annotation chips
// plus the message text, shared by the viewer and the thread composer (D27).
export function createDrafts() {
  let items = [];
  let text = "";
  const listeners = new Set();
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    list: () => items.slice(),
    text: () => text,
    setText(value) { text = value; },
    add(item) { items = [...items, { id: `annotation-${Date.now()}-${items.length}`, at: new Date().toISOString(), ...item }]; emit(); },
    update(id, patch) { items = items.map((item) => (item.id === id ? { ...item, ...patch } : item)); emit(); },
    remove(id) { items = items.filter((item) => item.id !== id); emit(); },
    take() { const taken = items; items = []; text = ""; emit(); return taken; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
