/** One enabled-harness demonstration. Structure evidence is separate from semantic review. */
export const LIVING_PLAN_CASE_ID = "living-plan.interaction-continuity";
export const livingPlanCase = Object.freeze({
  id: LIVING_PLAN_CASE_ID,
  name: "Living plan · specialist and follow-up",
  description: "Maintains internal task/interface planning through one specialist contribution and a changed user constraint in the same thread.",
  defaultSelected: false,
  prompts: Object.freeze([
    "Help me plan a small community repair café. We have one Saturday afternoon, a library meeting room, and six volunteers. Work out the repair stations, intake and safety approach, and a practical volunteer allocation. Use one semantic subcompletion for a focused review of intake and safety risks, read its findings, and integrate them into the overall proposal. Keep the work concise. Leave the supply budget as a clearly unresolved decision for now; do not assume it. Give me a useful overview with deeper supporting material only where it helps.",
    "Our supply budget is now $120, and one volunteer can only help for the first hour. Continue from the work already done: adapt the station choices and allocation, explain the tradeoffs, and make clear what we still need to decide. Do not start another specialist run unless the new information actually requires it.",
  ]),
  requiredChecks: Object.freeze(["agent-authored-complete"]),
  gradeExecution: gradeLivingPlanExecution,
});
const ok = (event) => event.status >= 200 && event.status < 300;
const publication = (event, owner) => ok(event) && event.method === "POST" && event.path === "/api/graph/plans"
  && event.planOwnerInteractionNodeId === owner && Number.isSafeInteger(event.planNodeId) && event.planNodeId > 0;
const read = (event) => ok(event) && event.method === "GET" && /^\/api\/graph\/plans\/[1-9]\d*$/.test(event.path)
  && Number.isSafeInteger(event.planNodeId) && Number.isSafeInteger(event.planOwnerInteractionNodeId);
const returned = (event) => ok(event) && event.method === "POST" && (event.path === "/api/graph/submit"
  || (event.path === "/api/graph/current/transitions" && event.transitionKind === "return"));

export async function gradeLivingPlanExecution({ execution, interactions, loadGraphOperations }) {
  if (interactions.length !== 2) throw new Error("Living-plan evidence requires two product turns in the same thread.");
  const owners = interactions.map(({ interaction }) => interaction.graphNodeId);
  const ledgers = await Promise.all(execution.turns.map(loadGraphOperations));
  const children = execution.semanticChildren ?? [];
  const childOwners = new Set(children.filter((child) => child.status === "accepted" && child.resultCompletionStatus === "accepted" && child.durable === true)
    .map((child) => child.graphNodeId));
  return { turns: ledgers.map((events, index) => {
    const published=events.filter((event) => publication(event,owners[index]));
    const finalReturn=events.findLast(returned);
    const searched=events.some((event) => ok(event) && event.method === "POST" && event.path === "/api/graph/search");
    const reads=events.filter(read);
    const firstTurnPlans = new Set(ledgers[0].filter((event) => publication(event, owners[0])).map((event) => event.planNodeId));
    const priorReads=reads.filter((event) => index === 0
      ? childOwners.has(event.planOwnerInteractionNodeId)
      : event.planOwnerInteractionNodeId === owners[0] && firstTurnPlans.has(event.planNodeId));
    const actualChildRead=reads.find((event) => childOwners.has(event.planOwnerInteractionNodeId));
    const followed=priorReads.some((observed) => published.some((written) => written.sequence > observed.sequence
      && written.readPlanNodeIds?.includes(observed.planNodeId)));
    const checks=[
      {name:"living-plan-own-contribution",passed:published.length>0,detail:"The current interaction published its own internal planning contribution."},
      {name:"living-plan-search-discovery",passed:searched,detail:"The candidate executed the public graph-search route."},
      {name:"living-plan-before-return",passed:!!finalReturn && published.some((event) => event.sequence<finalReturn.sequence),detail:"A successful plan publication preceded terminal graph Return."},
      {name:"living-plan-prior-pointer-incorporation",passed:followed,detail:"The candidate read the successful child's plan (first turn) or the preceding root's published plan (follow-up), then retained that exact pointer in its own contribution."},
    ];
    if(index===0) checks.push({name:"living-plan-successful-semantic-child",passed:!!actualChildRead,detail:"A successful semantic child's own planning contribution was read by the enclosing candidate."});
    return {checks,evidence:{interactionNodeId:owners[index],publishedPlanNodeIds:published.map((event)=>event.planNodeId),readPlanNodeIds:reads.map((event)=>event.planNodeId),semanticChildOwners:[...childOwners],semanticQuality:"Requires separate review of the actual plans and rendered work; these checks prove graph use only."}};
  })};
}
