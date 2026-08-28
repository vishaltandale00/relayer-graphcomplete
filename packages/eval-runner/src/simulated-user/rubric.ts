export type Rating = 1 | 2 | 3 | 4 | null;

export interface RubricCriterion {
  readonly label: string;
  readonly description: string;
}

const layerCriteria = {
  purpose_clarity: {
    label: "Purpose clarity",
    description: "The layer communicates why this grouping exists and what it covers.",
  },
  cohesion: {
    label: "Cohesion",
    description: "The visible nodes belong together and form a coherent response unit.",
  },
  visual_organization: {
    label: "Visual organization",
    description: "The rendered layer is readable and organized for its amount and shape of content.",
  },
  relationship_clarity: {
    label: "Relationship clarity",
    description: "The visible relationships help a user understand how the nodes connect.",
  },
  coverage: {
    label: "Coverage",
    description: "The layer covers the useful parts of its stated purpose without obvious fragmentation or gaps.",
  },
} as const satisfies Readonly<Record<string, RubricCriterion>>;

const nodeCriteria = {
  layer_fit: {
    label: "Layer fit",
    description: "The node belongs in the layer where it is presented.",
  },
  title_detail_alignment: {
    label: "Title-detail alignment",
    description: "The visible detail fulfills the expectation set by the node title.",
  },
  substance: {
    label: "Substance",
    description: "The node contains enough useful, relevant content to serve its role.",
  },
  detail_presentation: {
    label: "Detail presentation",
    description: "The selected-node detail is readable and easy to scan in the rendered product.",
  },
} as const satisfies Readonly<Record<string, RubricCriterion>>;

const navigateActionCriteria = {
  placement: {
    label: "Placement",
    description: "The action is attached to a source node where a user would expect it.",
  },
  label_expectation: {
    label: "Label expectation",
    description: "The label sets an accurate expectation for the destination.",
  },
  destination_delivery: {
    label: "Destination delivery",
    description: "The reached destination delivers what the action promised.",
  },
  added_value: {
    label: "Added value",
    description: "Following the action adds useful depth or context.",
  },
} as const satisfies Readonly<Record<string, RubricCriterion>>;

const invokeActionCriteria = {
  placement: {
    label: "Placement",
    description: "The action is attached to a source node where a user would expect it.",
  },
  label_expectation: {
    label: "Label expectation",
    description: "The label sets an accurate expectation for the disabled invocation.",
  },
  apparent_value: {
    label: "Apparent value",
    description: "The visible action appears useful even though immutable review cannot invoke it.",
  },
} as const satisfies Readonly<Record<string, RubricCriterion>>;

const turnCriteria = {
  answer_quality: {
    label: "Answer quality",
    description: "The completed turn gives the user a useful and appropriate answer.",
  },
  recursive_coherence: {
    label: "Recursive coherence",
    description: "Reachable layers remain coherent as the response expands recursively.",
  },
  navigation_value: {
    label: "Navigation value",
    description: "Navigation helps the user explore the answer without hiding or fragmenting its meaning.",
  },
  presentation_quality: {
    label: "Presentation quality",
    description: "The rendered turn is clear and usable as a product experience.",
  },
  follow_up_progress: {
    label: "Follow-up progress",
    description: "When applicable, the turn meaningfully advances the prior conversation.",
  },
} as const satisfies Readonly<Record<string, RubricCriterion>>;

export type LayerCriterionKey = keyof typeof layerCriteria;
export type NodeCriterionKey = keyof typeof nodeCriteria;
export type NavigateActionCriterionKey = keyof typeof navigateActionCriteria;
export type InvokeActionCriterionKey = keyof typeof invokeActionCriteria;
export type TurnCriterionKey = keyof typeof turnCriteria;

export type Ratings<CriterionKey extends string> = Readonly<Record<CriterionKey, Rating>>;
export type LayerRatings = Ratings<LayerCriterionKey>;
export type NodeRatings = Ratings<NodeCriterionKey>;
export type NavigateActionRatings = Ratings<NavigateActionCriterionKey>;
export type InvokeActionRatings = Ratings<InvokeActionCriterionKey>;
export type TurnRatings = Ratings<TurnCriterionKey>;

export type RubricSubject = "layer" | "node" | "navigate_action" | "invoke_action" | "turn";

export interface RubricSubjectDefinition<CriterionKey extends string> {
  readonly criteria: Readonly<Record<CriterionKey, RubricCriterion>>;
  readonly requiredScreenshotContext: readonly string[];
}

export interface SimulatedUserRubricManifest {
  readonly schemaVersion: 1;
  readonly rubricVersion:
    | "simulated-user-rubric-v1"
    | "graph-presentation-rubric-v2"
    | "graph-presentation-rubric-v3"
    | "graph-presentation-rubric-v4"
    | "graph-presentation-rubric-v5"
    | "graph-presentation-rubric-v6"
    | "graph-presentation-rubric-v7"
    | "graph-presentation-rubric-v8"
    | "graph-presentation-rubric-v9"
    | "graph-presentation-rubric-v10";
  readonly ratingScale: Readonly<Record<1 | 2 | 3 | 4, string>> | {
    readonly minimum: 1;
    readonly maximum: 8;
    readonly direction: "higher_is_better";
    readonly fixedPointMeanings: false;
    readonly reasonRequired: true;
    readonly screenshotEvidenceRequired: true;
  };
  readonly nullRating: {
    readonly meaning: string;
    readonly requiresJustification: true;
    readonly captureMoreEvidenceWhenAvailable: true;
  };
  readonly layerPolicy: {
    readonly recursive: true;
    readonly rootChildDistinction: false;
    readonly nodeCount: "qualitative_context_only";
    readonly automaticNodeCountThresholds: false;
  };
  readonly subjects: {
    readonly layer: RubricSubjectDefinition<LayerCriterionKey>;
    readonly node: RubricSubjectDefinition<NodeCriterionKey>;
    readonly navigate_action: RubricSubjectDefinition<NavigateActionCriterionKey>;
    readonly invoke_action: RubricSubjectDefinition<InvokeActionCriterionKey>;
    readonly turn: RubricSubjectDefinition<TurnCriterionKey>;
  };
  readonly recursiveJudgment?: {
    readonly contractId: string;
    readonly fixedNodeCapacity: 8;
    readonly allocationChoices: readonly ["expand", "reference", "invoke", "stop"];
    readonly allocationMargins: readonly ["close", "clearly_better", "necessary"];
    readonly bottomUpExpansion: true;
    readonly referenceRegrade: false;
    readonly invokeExecution: false;
    readonly arithmeticCompression: false;
    readonly finalTurnInput: readonly ["original_request", "artifact_evidence", "root_layer_result"];
    readonly nodeScoreDimensions?: readonly ["content", "actionAllocation", "actionDelivery", "recursiveQuality", "polish"];
  };
  readonly polishPolicy?: {
    readonly exclusiveEvidence: readonly ["readability", "spacing", "alignment", "clipping", "density", "render_consistency", "icon_consistency"];
    readonly mayAffectOtherRatings: false;
  };
}

export const SIMULATED_USER_RUBRIC_V1 = {
  schemaVersion: 1,
  rubricVersion: "simulated-user-rubric-v1",
  ratingScale: {
    1: "Fails its intended role.",
    2: "Has material problems.",
    3: "Succeeds with minor weaknesses.",
    4: "Clearly succeeds.",
  },
  nullRating: {
    meaning: "The criterion is genuinely not assessable from available UI evidence.",
    requiresJustification: true,
    captureMoreEvidenceWhenAvailable: true,
  },
  layerPolicy: {
    recursive: true,
    rootChildDistinction: false,
    nodeCount: "qualitative_context_only",
    automaticNodeCountThresholds: false,
  },
  subjects: {
    layer: {
      criteria: layerCriteria,
      requiredScreenshotContext: ["visible_layer_viewport"],
    },
    node: {
      criteria: nodeCriteria,
      requiredScreenshotContext: ["visible_layer_context", "selected_node_detail", "full_detail_tiles_when_needed"],
    },
    navigate_action: {
      criteria: navigateActionCriteria,
      requiredScreenshotContext: ["visible_source", "destination_reached_through_action"],
    },
    invoke_action: {
      criteria: invokeActionCriteria,
      requiredScreenshotContext: ["visible_source", "invocation_disabled_in_immutable_review"],
    },
    turn: {
      criteria: turnCriteria,
      requiredScreenshotContext: ["representative_completed_layer_node_and_action_evidence"],
    },
  },
} as const satisfies SimulatedUserRubricManifest;

export const DEFAULT_SIMULATED_USER_RUBRIC: SimulatedUserRubricManifest = SIMULATED_USER_RUBRIC_V1;

/** Presentation-only rubric for the graph grade; correctness belongs to the separate outcome grade. */
export const GRAPH_PRESENTATION_RUBRIC_V2 = {
  ...SIMULATED_USER_RUBRIC_V1,
  rubricVersion: "graph-presentation-rubric-v2",
  subjects: {
    ...SIMULATED_USER_RUBRIC_V1.subjects,
    node: {
      ...SIMULATED_USER_RUBRIC_V1.subjects.node,
      criteria: {
        ...SIMULATED_USER_RUBRIC_V1.subjects.node.criteria,
        substance: {
          label: "Visible information density",
          description: "The node presents an appropriate amount of information for its visual role without looking empty, cramped, or needlessly repetitive. Do not judge factual correctness here.",
        },
      },
    },
    turn: {
      ...SIMULATED_USER_RUBRIC_V1.subjects.turn,
      criteria: {
        ...SIMULATED_USER_RUBRIC_V1.subjects.turn.criteria,
        answer_quality: {
          label: "Response usability",
          description: "The completed graph is visually usable and appropriately organized for the request. Do not judge factual or task-outcome correctness here.",
        },
      },
    },
  },
} as const satisfies SimulatedUserRubricManifest;

/**
 * Artifact-grounded presentation rubric. The judge independently inspects the
 * candidate artifact, then uses screenshots as the authority for what the
 * graph actually communicates. Task outcome correctness remains a separate
 * grade.
 */
export const GRAPH_PRESENTATION_RUBRIC_V3 = {
  ...SIMULATED_USER_RUBRIC_V1,
  rubricVersion: "graph-presentation-rubric-v3",
  ratingScale: {
    1: "The user cannot reconstruct a meaningful handoff, or the presentation materially contradicts the artifact.",
    2: "The result is partly understandable, but a material part of the problem, work, evidence, or limits is missing.",
    3: "The user can understand the core problem, work, result, and evidence with only minor weaknesses.",
    4: "The graph is a strong, concise, artifact-grounded handoff with no material comprehension gaps.",
  },
  subjects: {
    ...SIMULATED_USER_RUBRIC_V1.subjects,
    layer: {
      ...SIMULATED_USER_RUBRIC_V1.subjects.layer,
      criteria: {
        ...SIMULATED_USER_RUBRIC_V1.subjects.layer.criteria,
        coverage: {
          label: "Contribution to the handoff",
          description: "The layer covers the task-relevant information it should contribute, based on artifact evidence, including detail that should have been disclosed from its parent.",
        },
      },
    },
    node: {
      ...SIMULATED_USER_RUBRIC_V1.subjects.node,
      criteria: {
        ...SIMULATED_USER_RUBRIC_V1.subjects.node.criteria,
        substance: {
          label: "Explanatory value",
          description: "The node helps the user understand the problem, material work, result, evidence, or limitations. A status card is not substantive merely because it is dense or polished.",
        },
      },
    },
    turn: {
      ...SIMULATED_USER_RUBRIC_V1.subjects.turn,
      criteria: {
        ...SIMULATED_USER_RUBRIC_V1.subjects.turn.criteria,
        answer_quality: {
          label: "Task-grounded handoff comprehension",
          description: "Judge whether the graph lets the user understand the task or problem, the material work and reasoning, the result, and its evidence or limitations. Give material work the greatest importance. Inspect the artifact to learn what matters, but credit communication only when it is visible in the graph.",
        },
        recursive_coherence: {
          label: "Recursive progressive disclosure",
          description: "At every node, decide whether more detail or an action is none, helpful, or required. Penalize missing needed disclosure at its parent; recursively grade every expansion that exists.",
        },
      },
    },
  },
} as const satisfies SimulatedUserRubricManifest;

/** Bottom-up semantic graph-presentation rubric. Historical v1-v3 artifacts remain readable unchanged. */
export const GRAPH_PRESENTATION_RUBRIC_V4 = {
  ...GRAPH_PRESENTATION_RUBRIC_V3,
  rubricVersion: "graph-presentation-rubric-v4",
  recursiveJudgment: {
    contractId: "recursive-presentation-judge-v2",
    fixedNodeCapacity: 8,
    allocationChoices: ["expand", "reference", "invoke", "stop"],
    allocationMargins: ["close", "clearly_better", "necessary"],
    bottomUpExpansion: true,
    referenceRegrade: false,
    invokeExecution: false,
    arithmeticCompression: false,
    finalTurnInput: ["original_request", "artifact_evidence", "root_layer_result"],
  },
  subjects: {
    ...GRAPH_PRESENTATION_RUBRIC_V3.subjects,
    layer: {
      ...GRAPH_PRESENTATION_RUBRIC_V3.subjects.layer,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V3.subjects.layer.criteria,
        coverage: {
          label: "Semantic contribution",
          description: "Judge the layer's fixed score/semantic vector as one contribution to its parent. Preserve meaningful weaknesses and evidence without mechanically averaging node scores.",
        },
      },
    },
    turn: {
      ...GRAPH_PRESENTATION_RUBRIC_V3.subjects.turn,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V3.subjects.turn.criteria,
        recursive_coherence: {
          label: "Recursive semantic allocation",
          description: "Judge bottom-up whether each node chose well among expand, reference, invoke, and stop; whether authored destinations delivered; and whether child findings were compressed into the parent at the right semantic importance.",
        },
      },
    },
  },
} as const satisfies SimulatedUserRubricManifest;

/** Missing-action-aware recursive rubric. Historical v1-v4 artifacts remain readable unchanged. */
export const GRAPH_PRESENTATION_RUBRIC_V5 = {
  ...GRAPH_PRESENTATION_RUBRIC_V4,
  rubricVersion: "graph-presentation-rubric-v5",
  recursiveJudgment: {
    ...GRAPH_PRESENTATION_RUBRIC_V4.recursiveJudgment,
    contractId: "recursive-presentation-judge-v3",
  },
  subjects: {
    ...GRAPH_PRESENTATION_RUBRIC_V4.subjects,
    turn: {
      ...GRAPH_PRESENTATION_RUBRIC_V4.subjects.turn,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V4.subjects.turn.criteria,
        recursive_coherence: {
          label: "Recursive semantic allocation",
          description: "Judge every authored action and every implicit stop. Record a first-class missing-action opportunity when a distinct artifact-grounded user question materially needs absent expansion, reference, or invocation.",
        },
      },
    },
  },
} as const satisfies SimulatedUserRubricManifest;

/** Interaction- and relationship-aware presentation rubric. The recursive data contract remains v3. */
export const GRAPH_PRESENTATION_RUBRIC_V6 = {
  ...GRAPH_PRESENTATION_RUBRIC_V5,
  rubricVersion: "graph-presentation-rubric-v6",
  subjects: {
    ...GRAPH_PRESENTATION_RUBRIC_V5.subjects,
    layer: {
      ...GRAPH_PRESENTATION_RUBRIC_V5.subjects.layer,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V5.subjects.layer.criteria,
        visual_organization: {
          label: "Visual hierarchy and choice legibility",
          description: "The rendered layer makes its important content and available choices easy to scan using supported graph affordances such as semantic placement, action variants, and icons. Do not require unsupported embedded images or screenshot banners.",
        },
        relationship_clarity: {
          label: "Relational structure",
          description: "Edges and placement visibly express useful relationships such as sequence, dependency, branching, alternatives, or evidence. An arbitrary row or line of boxes is weak when the task has meaningful structure it does not reveal.",
        },
      },
    },
    node: {
      ...GRAPH_PRESENTATION_RUBRIC_V5.subjects.node,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V5.subjects.node.criteria,
        detail_presentation: {
          label: "Detail and affordance presentation",
          description: "The selected-node detail and its available actions are readable, scannable, and easy to discover without forcing the user to hunt for the next useful step.",
        },
      },
    },
    navigate_action: {
      ...GRAPH_PRESENTATION_RUBRIC_V5.subjects.navigate_action,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V5.subjects.navigate_action.criteria,
        placement: {
          label: "Placement and discoverability",
          description: "The action is easy to find on the node where the corresponding user question or next step naturally arises.",
        },
        added_value: {
          label: "Distinct exploration value",
          description: "Following the action opens a worthwhile, distinct path rather than duplicating visible content, hiding required context, or adding action spam.",
        },
      },
    },
    invoke_action: {
      ...GRAPH_PRESENTATION_RUBRIC_V5.subjects.invoke_action,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V5.subjects.invoke_action.criteria,
        placement: {
          label: "Placement and discoverability",
          description: "The action is easy to find on the node where the user would naturally decide to take that next step.",
        },
        apparent_value: {
          label: "Apparent interactive value",
          description: "The visible action offers a clear, relevant next task and makes the graph feel usefully interactive even though immutable review cannot invoke it.",
        },
      },
    },
    turn: {
      ...GRAPH_PRESENTATION_RUBRIC_V5.subjects.turn,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V5.subjects.turn.criteria,
        answer_quality: {
          label: "Human-friendly graph experience",
          description: "The completed graph gives the user an approachable, useful way to understand and explore the response. It should feel intentionally graph-native rather than like prose split into boxes; factual and task-outcome correctness remain separate.",
        },
        navigation_value: {
          label: "Choice and navigation value",
          description: "The graph exposes the relevant, distinct inspect-or-act choices where users need them. Missing obvious paths, buried choices, redundant destinations, or overwhelming action spam reduce this score; there is no required action count.",
        },
        presentation_quality: {
          label: "Interactive presentation quality",
          description: "The supported visual hierarchy, relationships, actions, and details combine into an inviting, legible, and usable experience. Do not require media capabilities the product does not yet support.",
        },
      },
    },
  },
} as const satisfies SimulatedUserRubricManifest;

/** Human-experience-only rubric. Artifact correctness remains exclusively in the outcome grade. */
export const GRAPH_PRESENTATION_RUBRIC_V7 = {
  ...GRAPH_PRESENTATION_RUBRIC_V6,
  rubricVersion: "graph-presentation-rubric-v7",
  ratingScale: {
    1: "The rendered graph is unusable or fails to present a meaningful, navigable response experience.",
    2: "The response is understandable, but material interaction, navigation, hierarchy, or relational-presentation problems remain.",
    3: "The graph is useful and approachable with bounded human-experience weaknesses.",
    4: "The graph is an inviting, legible, graph-native experience with strong task-appropriate choices and relationships.",
  },
  subjects: {
    ...GRAPH_PRESENTATION_RUBRIC_V6.subjects,
    layer: {
      ...GRAPH_PRESENTATION_RUBRIC_V6.subjects.layer,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V6.subjects.layer.criteria,
        relationship_clarity: {
          label: "Relational structure",
          description: "Judge what the rendered geometry and edges actually explain. Score 4 only when important relationships are immediately clear; score 3 when they are mostly meaningful with minor ambiguity; score at most 2 when nodes are merely readable in a generic row, line, ring, or hub whose edges do not encode the task's sequence, dependency, branching, alternatives, comparison, or evidence relationships; score 1 when the structure is confusing or misleading.",
        },
        coverage: {
          label: "Experience coverage",
          description: "The layer exposes the content, choices, and progressive disclosure needed for its human-facing purpose. Use artifact inspection only to discover plausible inspect-or-act opportunities; do not grade whether the underlying work is correct.",
        },
      },
    },
    node: {
      ...GRAPH_PRESENTATION_RUBRIC_V6.subjects.node,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V6.subjects.node.criteria,
        substance: {
          label: "Visible explanatory value",
          description: "The node gives the user enough relevant explanation to understand its role and choose a useful next step. Do not raise or lower this presentation rating based on whether the underlying artifact or task outcome is correct.",
        },
      },
    },
    turn: {
      ...GRAPH_PRESENTATION_RUBRIC_V6.subjects.turn,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V6.subjects.turn.criteria,
        answer_quality: {
          label: "Immediate human usability",
          description: "Judge whether the rendered graph gives the user an approachable, understandable, and useful response experience. Underlying implementation, research, verifier, or task-outcome correctness belongs exclusively to the separate outcome grade.",
        },
        recursive_coherence: {
          label: "Progressive disclosure quality",
          description: "Judge whether the graph allocates expansion, reference, invoke, and stop well for human exploration. Penalize missing or excessive disclosure, but never convert an artifact defect or failed verifier into a presentation penalty by itself.",
        },
      },
    },
  },
} as const satisfies SimulatedUserRubricManifest;

/** Separates basic rendered polish from semantic and interactive graph quality. */
export const GRAPH_PRESENTATION_RUBRIC_V8 = {
  ...GRAPH_PRESENTATION_RUBRIC_V7,
  rubricVersion: "graph-presentation-rubric-v8",
  recursiveJudgment: {
    ...GRAPH_PRESENTATION_RUBRIC_V7.recursiveJudgment,
    contractId: "recursive-presentation-judge-v4",
    nodeScoreDimensions: ["content", "actionAllocation", "actionDelivery", "recursiveQuality", "polish"],
  },
  subjects: {
    ...GRAPH_PRESENTATION_RUBRIC_V7.subjects,
    layer: {
      ...GRAPH_PRESENTATION_RUBRIC_V7.subjects.layer,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V7.subjects.layer.criteria,
        visual_organization: {
          label: "Semantic visual organization",
          description: "Judge whether hierarchy, placement, and choice organization help the user understand and explore the response. Basic rendering cleanliness belongs only to the separate node polish score and cannot raise this rating.",
        },
      },
    },
    node: {
      ...GRAPH_PRESENTATION_RUBRIC_V7.subjects.node,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V7.subjects.node.criteria,
        detail_presentation: {
          label: "Detail interaction design",
          description: "Judge whether selected details and available actions are organized for understanding and choice. Basic readability and defect-free rendering belong only to the separate node polish score.",
        },
      },
    },
    turn: {
      ...GRAPH_PRESENTATION_RUBRIC_V7.subjects.turn,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V7.subjects.turn.criteria,
        presentation_quality: {
          label: "Graph-native presentation quality",
          description: "Judge semantic hierarchy, relationships, progressive disclosure, actions, and navigation as a combined experience. Do not award credit here merely because cards are clean, readable, aligned, or visually consistent; that basic integrity is recorded only as polish.",
        },
      },
    },
  },
} as const satisfies SimulatedUserRubricManifest;

/** Strict graph-native experience rubric. Clean rendering earns only polish credit. */
export const GRAPH_PRESENTATION_RUBRIC_V9 = {
  ...GRAPH_PRESENTATION_RUBRIC_V8,
  rubricVersion: "graph-presentation-rubric-v9",
  ratingScale: {
    1: "The result is primarily static prose-in-boxes or otherwise fails to provide a useful graph-native experience, even if it renders cleanly.",
    2: "The response is understandable, but material interaction, navigation, progressive-disclosure, information-architecture, or relational-structure problems remain.",
    3: "The graph provides genuinely useful task-appropriate choices, relationships, and progressive disclosure with only minor experience weaknesses.",
    4: "The graph is exceptional: immediately explorable, meaningfully structured, strongly interactive, and complete for its purpose, with no material experience gap.",
  },
  polishPolicy: {
    exclusiveEvidence: ["readability", "spacing", "alignment", "clipping", "density", "render_consistency", "icon_consistency"],
    mayAffectOtherRatings: false,
  },
  subjects: {
    ...GRAPH_PRESENTATION_RUBRIC_V8.subjects,
    layer: {
      ...GRAPH_PRESENTATION_RUBRIC_V8.subjects.layer,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V8.subjects.layer.criteria,
        visual_organization: {
          label: "Information architecture",
          description: "Judge whether hierarchy, grouping, placement, and choice architecture make the response easier to understand and explore than prose alone. Ignore readability, spacing, alignment, clipping, density, and render consistency; those earn credit only in polish.",
        },
        relationship_clarity: {
          label: "Relational structure",
          description: "Judge only relationships visibly communicated by the graph. Do not infer a sequence from card prose or mere adjacency. A generic line, row, ring, or hub is at most 2 unless its visible structure itself materially explains sequence, dependency, branching, alternatives, comparison, or evidence.",
        },
      },
    },
    node: {
      ...GRAPH_PRESENTATION_RUBRIC_V8.subjects.node,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V8.subjects.node.criteria,
        substance: {
          label: "Explanatory contribution",
          description: "Judge the node's distinct contribution to understanding or choosing a next step. Clean writing, typography, spacing, alignment, density, and defect-free rendering provide no credit here.",
        },
        detail_presentation: {
          label: "Detail interaction design",
          description: "Judge whether selected details expose meaningful explanation and inspect-or-act choices. Basic readability and rendering quality provide no credit here because they belong exclusively to polish.",
        },
      },
    },
    turn: {
      ...GRAPH_PRESENTATION_RUBRIC_V8.subjects.turn,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V8.subjects.turn.criteria,
        answer_quality: {
          label: "Graph response value",
          description: "Judge how much the graph interface helps the user understand, explore, and continue the response beyond what a clean textual handoff would provide. A readable static summary is at most 2.",
        },
        recursive_coherence: {
          label: "Progressive disclosure quality",
          description: "Judge whether expansion, reference, invoke, and stop choices form useful progressive disclosure. Multiple material missing choices are a major failure, not several minor independent weaknesses.",
        },
        navigation_value: {
          label: "Interaction and navigation value",
          description: "Judge whether important inspect-or-act paths are present, local to the user's decision point, distinct, and easy to choose. Static content quality and polish cannot compensate for missing paths.",
        },
        presentation_quality: {
          label: "Graph experience",
          description: "Judge the combined graph-native value of information architecture, relationships, progressive disclosure, actions, and navigation. Ignore every polish-only quality. Static prose-in-boxes is at most 2; a 3 requires genuinely useful graph structure with no material experience gap; 4 is exceptional.",
        },
      },
    },
  },
} as const satisfies SimulatedUserRubricManifest;

/** Reasoned 1-8 judgments: the rubric defines dimensions, not canned meanings for integers. */
export const GRAPH_PRESENTATION_RUBRIC_V10 = {
  ...GRAPH_PRESENTATION_RUBRIC_V9,
  rubricVersion: "graph-presentation-rubric-v10",
  ratingScale: {
    minimum: 1,
    maximum: 8,
    direction: "higher_is_better",
    fixedPointMeanings: false,
    reasonRequired: true,
    screenshotEvidenceRequired: true,
  },
  recursiveJudgment: {
    ...GRAPH_PRESENTATION_RUBRIC_V9.recursiveJudgment,
    contractId: "recursive-presentation-judge-v5",
  },
  subjects: {
    ...GRAPH_PRESENTATION_RUBRIC_V9.subjects,
    layer: {
      ...GRAPH_PRESENTATION_RUBRIC_V9.subjects.layer,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V9.subjects.layer.criteria,
        relationship_clarity: {
          label: "Relational structure",
          description: "Judge only relationships visibly communicated by the graph. Do not infer sequence from card prose or mere adjacency. Generic geometry deserves little credit unless the visible structure itself materially explains sequence, dependency, branching, alternatives, comparison, or evidence.",
        },
      },
    },
    turn: {
      ...GRAPH_PRESENTATION_RUBRIC_V9.subjects.turn,
      criteria: {
        ...GRAPH_PRESENTATION_RUBRIC_V9.subjects.turn.criteria,
        answer_quality: {
          label: "Graph response value",
          description: "Judge how much the graph interface helps the user understand, explore, and continue the response beyond what a clean textual handoff would provide. Readable static summary content supplies no graph-native credit by itself.",
        },
        presentation_quality: {
          label: "Graph experience",
          description: "Judge the combined graph-native value of information architecture, relationships, progressive disclosure, actions, and navigation. Ignore every polish-only quality. Static prose-in-boxes is a weak graph experience even when it is cleanly rendered.",
        },
      },
    },
  },
} as const satisfies SimulatedUserRubricManifest;

export interface RubricRatingValidationIssue {
  readonly code: "missing_rubric_key" | "unknown_rubric_key" | "invalid_rating";
  readonly key: string;
  readonly message: string;
}

export function getRubricCriterionKeys(subject: RubricSubject): readonly string[] {
  return Object.keys(SIMULATED_USER_RUBRIC_V1.subjects[subject].criteria);
}

export function validateRubricRatings(
  subject: RubricSubject,
  ratings: Readonly<Record<string, unknown>>,
): readonly RubricRatingValidationIssue[] {
  const expected = new Set(getRubricCriterionKeys(subject));
  const issues: RubricRatingValidationIssue[] = [];

  for (const key of expected) {
    if (!(key in ratings)) {
      issues.push({ code: "missing_rubric_key", key, message: `Missing ${subject} rating: ${key}` });
    }
  }
  for (const [key, rating] of Object.entries(ratings)) {
    if (!expected.has(key)) {
      issues.push({ code: "unknown_rubric_key", key, message: `Unknown ${subject} rating: ${key}` });
    } else if (rating !== null && rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4) {
      issues.push({ code: "invalid_rating", key, message: `Invalid ${subject} rating for ${key}` });
    }
  }
  return issues;
}
