// Opt-in synthetic mechanism probe, separate from natural coding-task quality.
// The ordinary catalog and its existing cases are unchanged when disabled.
export function currentCommunicationFrontierCases(baseline, enabled = false) {
  if (!enabled) return baseline;
  return [...baseline, Object.freeze({
    id: "current-communication.semantic-delegation",
    name: "Current communication · semantic delegation probe",
    description: "Explicitly requests two semantic subcompletions to observe child-current reading and useful parent publication; not spontaneous recursion evidence.",
    defaultSelected: false,
    prompts: Object.freeze([
      "Prepare a decision brief for a six-week private beta of Lantern, a fictional macOS desktop agent for local developer tools. The team has four engineers, no cloud execution, and expects 100 technical users. Delegate two independent assessments through separate GraphComplete complete(inputGraph) calls: one for consent and recovery UX, and one for runtime isolation, updates, and abuse risks. Give each specialist responsibility for publishing evidence and uncertainty as its assessment develops. Follow their published work while it runs and explain findings and conflicts to me as they become useful. Finish with an integrated recommendation, the five most important launch risks, and a concrete go/no-go checklist. Do not book, publish, or change any external service.",
    ]),
  })];
}
