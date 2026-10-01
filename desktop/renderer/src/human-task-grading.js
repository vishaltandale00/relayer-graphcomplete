// Eval-only controls; feedback stays in evidence and never enters the model prompt.
const reviewMoment = (event) => event.kind === "presentation" || event.kind === "actor_action";
const momentLabel = (event) => event.kind === "actor_action"
  ? `${event.sequence}. Actor ${event.action.kind} · ${event.action.comment || event.action.reason || event.action.value || ""} · ${event.at}`
  : `${event.sequence}. Graph ${event.snapshot?.layerId ?? ""}${event.snapshot?.selectedNodeId ? ` · node ${event.snapshot.selectedNodeId}` : ""} · ${event.at}`;
export function initializeHumanTaskGrading(bridge) {
  const panel = document.createElement("details");
  panel.id = "humanTaskGrading";
  panel.className = "human-task-grading";
  panel.innerHTML = `<summary>Review &amp; grade</summary>
    <p>Save a rating or comment on a graph moment without ending the task. Use the graph’s ✎ controls for comments on specific nodes when available.</p>
    <a data-current-step hidden>Open current step ↗</a><button type="button" data-grade-refresh>Refresh session status</button><div data-grade-content></div><p role="status" aria-live="polite" data-grade-status></p>`;
  document.body.append(panel);
  const content = panel.querySelector("[data-grade-content]");
  const status = panel.querySelector("[data-grade-status]");
  let busy = false;
  let renderedStatus;
  const run = async (operation) => {
    if (busy) return;
    busy = true;
    const buttons = [...content.querySelectorAll("button")];
    buttons.forEach((button) => { button.disabled = true; });
    status.textContent = "Saving…";
    try { await operation(); }
    catch (error) {
      // Another tab may have finished the session; preserve drafts on other errors.
      try { const task = await bridge.task(); if (task.status !== renderedStatus) render(task); } catch { /* Keep the original failure visible. */ }
      status.textContent = error.message;
    }
    finally { busy = false; buttons.forEach((button) => { button.disabled = false; }); }
  };
  function currentStep(task) {
    const link = panel.querySelector("[data-current-step]");
    const target = new URL(window.location.href);
    link.hidden = task.mode !== "simulated" || task.currentThreadId == null || String(task.currentThreadId) === target.searchParams.get("threadId");
    target.searchParams.set("threadId", String(task.currentThreadId));
    for (const key of ["interactionId", "layerId", "nodeId"]) target.searchParams.delete(key);
    link.href = target.href;
  }
  function render(task) {
    currentStep(task);
    renderedStatus = task.status;
    content.replaceChildren();
    if (task.prepared?.humanBrief) {
      const brief = document.createElement("details");
      const title = document.createElement("summary"); title.textContent = "Private user brief · not sent to Relayer";
      const text = document.createElement("p"); text.className = "human-task-private-brief"; text.textContent = task.prepared.humanBrief;
      const rubric = document.createElement("p"); rubric.textContent = task.prepared.humanRubric;
      brief.append(title, text, rubric); content.append(brief);
    }
    if (task.workspaceGrading !== 2) {
      const message = document.createElement("p");
      message.textContent = "Restart Eval to enable grading without ending the task. This host still uses the older combined grading flow.";
      content.append(message);
      return;
    }
    if (["active", "completed", "failed", "interrupted"].includes(task.status)) {
      content.insertAdjacentHTML("beforeend", `<form data-session-grade>
        <label>Satisfaction<select name="satisfaction" required><option value="">Choose…</option><option value="1">1 · Bad</option><option value="2">2 · Needs work</option><option value="3">3 · Good</option><option value="4">4 · Great</option></select></label>
        <label>Feedback<textarea name="comment" maxlength="8000" rows="3"></textarea></label>
        <button type="submit">Save grade</button></form>`);
      const form = content.querySelector("[data-session-grade]");
      form.elements.satisfaction.value = String(task.satisfaction?.value || "");
      form.elements.comment.value = task.satisfaction?.comment || "";
      form.onsubmit = (event) => {
        event.preventDefault();
        void run(async () => {
          const input = Object.fromEntries(new FormData(form));
          const saved = await bridge.grade({ ...input, satisfaction: Number(input.satisfaction) });
          status.textContent = saved.status === "active" ? "Grade saved. You can keep interacting with the graph." : "Grade saved. This task has ended; you can continue reviewing.";
        });
      };
      const annotation = document.createElement("form");
      annotation.innerHTML = `<p>Choose a graph moment or actor action. For actor feedback, note whether it was too articulate, invented a preference, stopped early, or explored unnecessarily. Refresh to load recent moments.</p><label>Graph moment<select name="eventId" required></select></label><label>Moment feedback<textarea name="comment" required maxlength="8000" rows="3"></textarea></label><button type="submit">Save moment annotation</button>`;
      for (const event of task.events.filter(reviewMoment)) {
        annotation.elements.eventId.add(new Option(momentLabel(event), event.id));
      }
      annotation.elements.eventId.selectedIndex = annotation.elements.eventId.options.length - 1;
      annotation.onsubmit = (event) => {
        event.preventDefault();
        void run(async () => {
          const saved = await bridge.annotate(Object.fromEntries(new FormData(annotation)));
          annotation.elements.comment.value = "";
          status.textContent = saved.status === "active" ? "Moment annotation saved. You can keep interacting." : "Moment annotation saved. This task has ended; you can continue reviewing.";
        });
      };
      content.append(annotation);
      for (const note of task.annotations) {
        const row = document.createElement("p"); row.textContent = note.comment; content.append(row);
      }
    }
    if (task.status === "active" && typeof bridge.finish === "function") {
      const finish = document.createElement("form");
      finish.innerHTML = `<p>Finish only when you are done interacting. No rating is required.</p><label>Finish reason<select name="reason"><option value="satisfied">Satisfied</option><option value="endpoint_reached">Endpoint reached</option><option value="abandoned">Abandoned</option><option value="budget_exhausted">Completion limit reached</option></select></label><button type="submit">Finish task</button>`;
      finish.onsubmit = (event) => {
        event.preventDefault();
        void run(async () => {
          const saved = await bridge.finish(Object.fromEntries(new FormData(finish)));
          render({ ...saved, workspaceGrading: 2 });
          status.textContent = "Task finished. You can still review and grade the graph.";
        });
      };
      content.append(finish);
    }

  }
  panel.querySelector("[data-grade-refresh]").onclick = () => {
    if (busy) return;
    void bridge.task().then((task) => {
      currentStep(task);
      if (task.status !== renderedStatus || !content.childElementCount) render(task);
      const moments = content.querySelector('[name="eventId"]');
      if (task.status === "active" && moments) {
        const selected = moments.value;
        moments.replaceChildren();
        for (const event of task.events.filter(reviewMoment)) moments.add(new Option(momentLabel(event), event.id));
        if ([...moments.options].some((option) => option.value === selected)) moments.value = selected;
        else moments.selectedIndex = moments.options.length - 1;
      }
      status.textContent = `Session ${task.status}.`;
    }).catch((error) => { status.textContent = error.message; });
  };
  panel.addEventListener("toggle", () => {
    if (panel.open && !content.childElementCount) void bridge.task().then(render).catch((error) => {
      status.textContent = `${error.message} Close and reopen this panel to retry.`;
    });
  });
}
