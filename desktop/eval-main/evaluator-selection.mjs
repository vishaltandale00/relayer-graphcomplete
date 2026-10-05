// Resolve all evaluator identities before provider discovery or candidate dispatch.
// A release is an explicit immutable selection, never a moving default.
export function resolveEvaluatorSelection(registry, selection) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!registry) {
    if (selection.evaluatorReleaseId || selection.completionJudgeRevisionId) fail("Evaluator registry is unavailable.");
    return { selection, actorSetup: null, completionJudgeSetup: null, evaluatorRelease: null };
  }
  const evaluatorRelease = selection.evaluatorReleaseId ? registry.release(selection.evaluatorReleaseId) : null;
  if (evaluatorRelease) {
    for (const [field, revision] of [["actorSetupRevisionId", evaluatorRelease.actorSetup], ["completionJudgeRevisionId", evaluatorRelease.completionJudgeSetup], ["judgeSetupRevisionId", evaluatorRelease.judgeSetup]]) {
      if (selection[field] && selection[field] !== revision.id) fail("Evaluator release conflicts with a component selection.");
    }
  }
  const actorSetup = evaluatorRelease?.actorSetup ?? registry.selected("actor", selection.actorSetupRevisionId);
  const completionJudgeSetup = evaluatorRelease?.completionJudgeSetup ?? (selection.completionJudgeRevisionId ? registry.get(selection.completionJudgeRevisionId, "completion-judge") : null);
  return {
    actorSetup, completionJudgeSetup, evaluatorRelease,
    selection: { ...selection, actorSetupRevisionId: actorSetup.id,
      ...(completionJudgeSetup ? { completionJudgeRevisionId: completionJudgeSetup.id } : {}),
      ...(evaluatorRelease ? { judgeSetupRevisionId: evaluatorRelease.judgeSetup.id } : {}) },
  };
}
export const completionJudgeSpec = task => task.completionJudgeSetup?.spec ?? task.actorSetup?.behaviorContract?.completionJudge;
