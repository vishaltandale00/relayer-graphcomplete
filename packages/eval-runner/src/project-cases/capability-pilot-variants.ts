import { DEFAULT_STEERED_MAX_HUMAN_TURNS, type InteractionVariant } from "./interaction-variants.js";

export const CAPABILITY_PILOT_SUITE_ID = "harness-capability-pilot-v1" as const;

export const capabilityPilotFamilyIds = Object.freeze([
  "capability.greenfield.reservation-capacity",
  "capability.greenfield.tournament-operations",
  "capability.greenfield.api-contract-simulation-laboratory",
  "capability.greenfield.emergency-evacuation-route-planner",
  "autonomous.httpcore.cancellation-poisoned-pool",
  "autonomous.node-redis.command-queue-race",
  "autonomous.excalidraw.scene-history",
  "jupyterlab.reproducible-execution-bundles",
  "capability.spreadsheet.saas-operating-model",
  "capability.spreadsheet.production-delivery-planner",
] as const);

export type CapabilityPilotFamilyId = typeof capabilityPilotFamilyIds[number];

export interface CapabilityPilotVariantMember {
  readonly caseId: string;
  readonly variant: InteractionVariant;
  readonly name: string;
  readonly openingPrompt: string;
  readonly simulatedUserBrief?: string;
  readonly maxHumanTurns?: number;
}

export interface CapabilityPilotFamily {
  readonly familyId: CapabilityPilotFamilyId;
  readonly name: string;
  readonly taskType: "greenfield-build" | "debugging" | "feature-change" | "spreadsheet-model";
  readonly fixtureStatus: "external-admitted" | "external-candidate";
  readonly members: {
    readonly "single-turn": CapabilityPilotVariantMember;
    readonly "multi-turn": CapabilityPilotVariantMember;
  };
}

function member(
  familyId: CapabilityPilotFamilyId,
  variant: InteractionVariant,
  name: string,
  openingPrompt: string,
  extra: { readonly simulatedUserBrief?: string; readonly maxHumanTurns?: number } = {},
): CapabilityPilotVariantMember {
  return Object.freeze({
    caseId: `${familyId}.${variant}`,
    variant,
    name,
    openingPrompt,
    ...extra,
  });
}

function family(
  familyId: CapabilityPilotFamilyId,
  name: string,
  taskType: CapabilityPilotFamily["taskType"],
  fixtureStatus: CapabilityPilotFamily["fixtureStatus"],
  singleTurn: string,
  multiTurn: { readonly openingPrompt: string; readonly simulatedUserBrief: string; readonly maxHumanTurns?: number },
): CapabilityPilotFamily {
  return Object.freeze({
    familyId,
    name,
    taskType,
    fixtureStatus,
    members: Object.freeze({
      "single-turn": member(familyId, "single-turn", `${name} · one turn`, singleTurn),
      "multi-turn": member(familyId, "multi-turn", `${name} · steered`, multiTurn.openingPrompt, {
        simulatedUserBrief: multiTurn.simulatedUserBrief,
        maxHumanTurns: multiTurn.maxHumanTurns ?? DEFAULT_STEERED_MAX_HUMAN_TURNS,
      }),
    }),
  });
}

export const capabilityPilotVariantFamilies: readonly CapabilityPilotFamily[] = Object.freeze([
  family(
    "capability.greenfield.reservation-capacity",
    "Reservation and capacity product",
    "greenfield-build",
    "external-admitted",
    "Build a reservation product with availability, expiring holds, idempotent confirmation, concurrent contention, time-zone-safe schedules, cancellation, and restart-safe persistence. Preserve the public seam in README.md, add focused tests, commit locally, and do not push.",
    {
      maxHumanTurns: 8,
      openingPrompt: "I need a booking product for rooms that can be held and then confirmed. Holds should expire, two people must not take the last slot, and the schedule has to respect local time zones. Please start in the graph so I can steer as you go, then make it real in this repo.",
      simulatedUserBrief: "You operate a small venues business. You know holds must expire, confirmation must be retry-safe, and overlapping bookings are unacceptable. You can answer product questions about time zones, cancellation, and restart. After each accepted graph, check whether the visible plan covers contention and expiry. Ask for missing behavior you care about. Stop when a usable product appears committed, or abandon if the work ignores the public seam.",
    },
  ),
  family(
    "capability.greenfield.tournament-operations",
    "Tournament operations platform",
    "greenfield-build",
    "external-admitted",
    "Build a tournament operations web app for a regional youth championship. It must register and seed teams, create balanced pools and a seeded elimination bracket, schedule matches within venue/court windows without double-booking a team or court, record results, calculate standings with head-to-head/score-difference/seed tie-breakers, advance qualifiers, handle withdrawals, and safely reschedule matches. Surface schedule feasibility and actionable conflicts instead of silently producing an impossible plan. Preserve the public black-box seam documented in README.md. Commit locally and do not push.",
    {
      maxHumanTurns: 8,
      openingPrompt: "We are running a regional youth championship this month and need an operations app. Registration, pools, a bracket, venue scheduling, results, withdrawals, and rescheduling all have to work together. Please keep the plan visible in the graph as you build so I can catch schedule conflicts early.",
      simulatedUserBrief: "You are the tournament director. You care about double-booking, withdrawals, and whether an impossible schedule is shown as a conflict. You can confirm two pools and two qualifiers per pool. After each accepted graph, inspect the visible plan and ask about any missing operator flow. Do not paste verifier matrices. Stop when the director interface and public seam look complete enough to try.",
    },
  ),
  family(
    "capability.greenfield.api-contract-simulation-laboratory",
    "API contract simulation laboratory",
    "greenfield-build",
    "external-admitted",
    "Build a contract-driven mock laboratory: import revisions, run a deterministic mock service, inject latency and failures, validate clients, and compare contract revisions behind the public HTTP seam in README.md. Add focused tests, commit locally, and do not push.",
    {
      maxHumanTurns: 8,
      openingPrompt: "I want a local lab where I can import an API contract, run a mock, break it on purpose with latency and failures, and compare revisions. Please start with a visible plan and keep me in the loop while you build the public HTTP seam.",
      simulatedUserBrief: "You are a client-team lead. You need import errors to be directional, mocks to be deterministic, and revision diffs to be trustworthy. After each accepted graph, look for those capabilities. Ask for a missing fault or comparison path. Stop when the laboratory looks usable against the README seam.",
    },
  ),
  family(
    "capability.greenfield.emergency-evacuation-route-planner",
    "Emergency evacuation route planner",
    "greenfield-build",
    "external-candidate",
    "Build an evacuation planner over the frozen street network with closures, vehicle capacity, accessibility, pickup dependencies, deadlines, priorities, alternatives, and conservation. Preserve the public seam in README.md, commit locally, and do not push.",
    {
      maxHumanTurns: 8,
      openingPrompt: "We have a frozen street network and need an evacuation planner that respects closures, capacity, accessibility, pickup order, and deadlines. Please keep alternatives and infeasible cases visible in the graph while you build, because I will challenge unsafe routes.",
      simulatedUserBrief: "You are an emergency operations officer. You can confirm accessibility needs, deadlines, and that people and vehicles must be conserved. After each accepted graph, inspect whether closures and alternatives are visible. Challenge a plan that drops constraints. Stop when the planner looks like it would survive a tabletop exercise.",
    },
  ),
  family(
    "autonomous.httpcore.cancellation-poisoned-pool",
    "HTTPCore cancellation-poisoned connection pool",
    "debugging",
    "external-admitted",
    "Fix the cancellation race in this HTTPCore checkout. Cancellation after asynchronous TCP connection setup begins must not poison a one-slot connection pool: the slot must be released, a later request must succeed, repeated cancellation must remain safe, and pool shutdown must clean up loopback connections. Run the relevant focused regression checks and create one meaningful local commit. Keep the change scoped and do not push.",
    {
      openingPrompt: "Cancellation during async connect is poisoning our one-slot HTTPCore pool. Later requests fail even after the cancel. Please inspect this checkout, keep the diagnosis visible, and repair it if you are sure. I will follow along. Commit locally when it is ready, and do not push.",
      simulatedUserBrief: "You hit this in production as hung later requests after a cancelled connect. You can confirm a one-slot pool and that shutdown should release loopback connections. You do not know the upstream patch. After each accepted graph, check that the visible diagnosis names slot release and later-request success. Ask for missing evidence. Stop after a scoped committed repair, or abandon if the change looks unrelated.",
    },
  ),
  family(
    "autonomous.node-redis.command-queue-race",
    "Node Redis disconnect command-queue race",
    "debugging",
    "external-admitted",
    "Fix the historical socket-error interleaving that can poison command/reply association after reconnect. Make the fault deterministic with evaluator-owned injection, verify queue cleanup and reply ordering, and commit a scoped local repair. Do not push.",
    {
      openingPrompt: "After a socket error, Node Redis sometimes mixes up later replies with earlier commands. Please investigate this checkout in the graph, then repair the race if you can prove it. I will stay with you. Commit locally and do not push.",
      simulatedUserBrief: "You saw misassociated replies after disconnect. You can confirm reconnect, queue cleanup, and repeated failures matter. You do not know the exact interleaving. After each accepted graph, look for a diagnosis that protects reply ordering. Ask for a reproduction. Stop when a scoped repair is committed.",
    },
  ),
  family(
    "autonomous.excalidraw.scene-history",
    "Excalidraw branching scene history",
    "feature-change",
    "external-candidate",
    "Add named scene versions, historical branching, deterministic merge, surfaced conflicts, and durable history that preserves bindings, groups, assets, undo/export, and historical document compatibility. Keep the change scoped, commit locally, and do not push.",
    {
      maxHumanTurns: 8,
      openingPrompt: "I need Excalidraw scene history that can branch, merge, and show conflicts without losing bindings or assets. Please keep the design visible while you work in this checkout so I can object to silent merges. Commit locally and do not push.",
      simulatedUserBrief: "You are a design-tool user who needs named versions and honest conflicts. After each accepted graph, inspect whether branching, merge, and compatibility are present. Challenge a silent overwrite. Stop when the feature looks usable on the frozen repository.",
    },
  ),
  family(
    "jupyterlab.reproducible-execution-bundles",
    "JupyterLab reproducible execution bundles",
    "feature-change",
    "external-candidate",
    "Add reproducible execution bundles to JupyterLab: export environment identity, ordered execution evidence, outputs, referenced files, and integrity hashes; import read-only; compare a rerun; detect missing inputs and tampering. Commit locally and do not push.",
    {
      maxHumanTurns: 8,
      openingPrompt: "I want JupyterLab notebooks to export a reproducible execution bundle I can import read-only and compare against a rerun. Tampering and missing files should be obvious. Please keep the contract visible as you implement it in this checkout. Commit locally and do not push.",
      simulatedUserBrief: "You are a scientist who needs integrity hashes and a read-only import. After each accepted graph, check environment identity, ordered evidence, and tamper detection. Ask for any missing comparison path. Stop when the public APIs look complete.",
    },
  ),
  family(
    "capability.spreadsheet.saas-operating-model",
    "SaaS operating model workbook",
    "spreadsheet-model",
    "external-candidate",
    "From the messy subscription, invoice, payment, payroll, expense, and cash exports, build a reconciled historical model, revenue and churn analysis, a twelve-month forecast with multiple scenarios, cash runway, and an executive dashboard. The workbook must respond to changed inputs through formulas. Commit the .xlsx locally and do not push.",
    {
      maxHumanTurns: 10,
      openingPrompt: "Finance dumped six messy exports on me. I need a real operating model: reconciled history, churn, a twelve-month forecast with scenarios, runway, and a dashboard leadership can trust. Please keep the model decisions visible while you build so I can challenge hardcoded answers.",
      simulatedUserBrief: "You are the operator who owns these exports. You can confirm scenario names and that totals must move when inputs change. After each accepted graph, look for reconciliation, scenarios, and a dashboard. Ask when a number looks hardcoded. Stop when the workbook looks auditable.",
    },
  ),
  family(
    "capability.spreadsheet.production-delivery-planner",
    "Production and delivery planner workbook",
    "spreadsheet-model",
    "external-candidate",
    "From orders, bills of material, inventory, supplier lead times, weekly capacity, and shipping options, build a twelve-week production and fulfillment plan with exceptions, expedite choices, scenario controls, and a management dashboard. The workbook must respond to changed inputs. Commit the .xlsx locally and do not push.",
    {
      maxHumanTurns: 10,
      openingPrompt: "I need a twelve-week production and delivery plan from these orders, BOMs, inventory, lead times, capacity, and shipping options. Show exceptions and expedite choices. Keep the planning decisions visible as you build; I will challenge an infeasible week. Commit the workbook locally and do not push.",
      simulatedUserBrief: "You are the plant planner. You can confirm that short or late demand must be explicit. After each accepted graph, inspect conservation, capacity, and exceptions. Ask for a missing scenario or dashboard. Stop when the plan looks usable by management.",
    },
  ),
]);

export const capabilityPilotVariantMembers = Object.freeze(
  capabilityPilotVariantFamilies.flatMap((entry) => [entry.members["single-turn"], entry.members["multi-turn"]]),
);

export function capabilityPilotFamily(familyId: CapabilityPilotFamilyId): CapabilityPilotFamily {
  const found = capabilityPilotVariantFamilies.find((entry) => entry.familyId === familyId);
  if (!found) throw new Error(`Unknown capability-pilot family: ${familyId}`);
  return found;
}
