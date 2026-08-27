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
    | "graph-presentation-rubric-v5";
  readonly ratingScale: Readonly<Record<1 | 2 | 3 | 4, string>>;
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
