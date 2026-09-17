// PROTOTYPE DATA - throwaway. Two real threads copied from a local Relayer product database on 2026-09-11.
// Shape mirrors the app server's /api/state interaction and thread responses, not conversation-export v1.
// Root layers only: the local graph store had no nested layers.
export const SNAPSHOTS = {
 "1": {
  "thread": {
   "id": 1,
   "title": "Why can time seem to pass faster as we get older?",
   "projectId": null,
   "rootInteractionId": 1,
   "harnessConfigurationName": "codex-basic",
   "harnessId": "codex-basic",
   "permissionProfileId": "auto",
   "createdAt": "1787850770729",
   "updatedAt": "1787853170819",
   "imported": true
  },
  "projectName": null,
  "producer": {
   "desktopVersion": "prototype",
   "platform": "darwin"
  },
  "interactions": [
   {
    "id": 1,
    "threadId": 1,
    "sequence": 1,
    "text": "Why can time seem to pass faster as we get older?",
    "createdAt": "1787850770729",
    "graphNodeId": 1,
    "completionStatus": "accepted",
    "harnessConfigurationName": "codex-basic",
    "modelSelection": {
     "providerId": "codex",
     "modelId": "gpt-5.6-sol"
    },
    "completionOutput": {
     "nodeId": 1,
     "rootAction": {
      "description": null,
      "icon": null,
      "id": 3,
      "interactionText": null,
      "kind": "navigate",
      "label": "Response",
      "relation": "expand",
      "sourceLayerId": null,
      "sourceNodeId": 1,
      "state": "accepted",
      "targetLayerId": 1,
      "variant": "pill"
     },
     "rootLayer": {
      "actions": [
       {
        "description": null,
        "icon": "arrow-right-left",
        "id": 1,
        "interactionText": "Explain the difference between prospective and retrospective time perception with everyday examples.",
        "kind": "invoke",
        "label": "Explore two kinds of time perception",
        "relation": null,
        "sourceLayerId": 1,
        "sourceNodeId": 6,
        "state": "accepted",
        "targetLayerId": null,
        "variant": "chip"
       },
       {
        "description": null,
        "icon": "sprout",
        "id": 2,
        "interactionText": "Give me a realistic weekly plan for making time feel richer and less repetitive without overloading my schedule.",
        "kind": "invoke",
        "label": "Build a practical novelty plan",
        "relation": null,
        "sourceLayerId": 1,
        "sourceNodeId": 7,
        "state": "accepted",
        "targetLayerId": null,
        "variant": "chip"
       }
      ],
      "edges": [
       {
        "endpoints": [
         2,
         3
        ],
        "id": 1,
        "state": "accepted"
       },
       {
        "endpoints": [
         2,
         4
        ],
        "id": 2,
        "state": "accepted"
       },
       {
        "endpoints": [
         2,
         5
        ],
        "id": 3,
        "state": "accepted"
       },
       {
        "endpoints": [
         2,
         6
        ],
        "id": 4,
        "state": "accepted"
       },
       {
        "endpoints": [
         2,
         7
        ],
        "id": 5,
        "state": "accepted"
       }
      ],
      "layer": {
       "edges": [
        1,
        2,
        3,
        4,
        5
       ],
       "id": 1,
       "layout": {
        "placements": [
         {
          "nodeId": 2,
          "x": 0.5,
          "y": 0.43
         },
         {
          "nodeId": 3,
          "x": 0.18,
          "y": 0.16
         },
         {
          "nodeId": 4,
          "x": 0.5,
          "y": 0.08
         },
         {
          "nodeId": 5,
          "x": 0.82,
          "y": 0.16
         },
         {
          "nodeId": 6,
          "x": 0.22,
          "y": 0.76
         },
         {
          "nodeId": 7,
          "x": 0.78,
          "y": 0.76
         }
        ],
        "version": 1
       },
       "nodes": [
        2,
        3,
        4,
        5,
        6,
        7
       ],
       "state": "accepted"
      },
      "nodes": [
       {
        "detail": "Clock time does not speed up. **Retrospective time** - how long a period seems when we look back - often feels compressed because routine periods leave fewer distinctive memories, each year is a smaller fraction of a longer life, and attention is increasingly divided. The effect is common, but not universal.",
        "icon": "brain",
        "id": 2,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "Why time often feels faster with age"
       },
       {
        "detail": "Childhood and early adulthood contain many firsts. New experiences demand attention and produce dense, distinctive memories. Repeated routines are encoded more sparsely, so months with few memorable landmarks can look short in hindsight.",
        "icon": "star",
        "id": 3,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "Novelty creates landmarks"
       },
       {
        "detail": "At age 10, one year is 10% of the life lived; at 50, it is 2%. This **ratio idea** is an intuitive contributor, though it is not a complete scientific explanation by itself.",
        "icon": "pie-chart",
        "id": 4,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "A year becomes proportionally smaller"
       },
       {
        "detail": "Busy schedules, multitasking, and familiar automatic behaviors reduce how closely we monitor passing moments. Less attention to experience can mean fewer details encoded, which later makes an interval seem compressed.",
        "icon": "cpu",
        "id": 5,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "Attention gets crowded"
       },
       {
        "detail": "Time perception has two faces. A boring afternoon can feel slow **while it happens**, yet a routine month may feel short **when recalled**. Emotion, stress, anticipation, sleep, and health can shift either experience.",
        "icon": "arrow-right-left",
        "id": 6,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "In the moment vs. in memory"
       },
       {
        "detail": "Add memorable boundaries: learn unfamiliar skills, vary routes and routines, take photos or journal selectively, and give experiences undivided attention. These do not slow the clock; they create richer memory structure, making a period feel fuller in retrospect.",
        "icon": "sprout",
        "id": 7,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "How to make life feel less compressed"
       }
      ]
     }
    },
    "completionError": null,
    "latestAttempt": null,
    "projectionFresh": true,
    "contexts": [],
    "submittedInputs": []
   },
   {
    "id": 2,
    "threadId": 1,
    "sequence": 2,
    "text": "Explain the difference between prospective and retrospective time perception with everyday examples.",
    "createdAt": "1787853170819",
    "graphNodeId": 8,
    "completionStatus": "accepted",
    "harnessConfigurationName": "codex-basic",
    "modelSelection": {
     "providerId": "codex",
     "modelId": "gpt-5.6-sol"
    },
    "completionOutput": {
     "nodeId": 8,
     "rootAction": {
      "description": null,
      "icon": null,
      "id": 5,
      "interactionText": null,
      "kind": "navigate",
      "label": "Response",
      "relation": "expand",
      "sourceLayerId": null,
      "sourceNodeId": 8,
      "state": "accepted",
      "targetLayerId": 2,
      "variant": "pill"
     },
     "rootLayer": {
      "actions": [
       {
        "description": null,
        "icon": "arrow-right-circle",
        "id": 4,
        "interactionText": "How does the prospective-versus-retrospective distinction help explain why time seems to speed up as we age?",
        "kind": "invoke",
        "label": "Apply this to aging",
        "relation": null,
        "sourceLayerId": 2,
        "sourceNodeId": 14,
        "state": "accepted",
        "targetLayerId": null,
        "variant": "chip"
       }
      ],
      "edges": [
       {
        "endpoints": [
         9,
         10
        ],
        "id": 6,
        "state": "accepted"
       },
       {
        "endpoints": [
         10,
         11
        ],
        "id": 7,
        "state": "accepted"
       },
       {
        "endpoints": [
         9,
         12
        ],
        "id": 8,
        "state": "accepted"
       },
       {
        "endpoints": [
         12,
         13
        ],
        "id": 9,
        "state": "accepted"
       },
       {
        "endpoints": [
         9,
         14
        ],
        "id": 10,
        "state": "accepted"
       }
      ],
      "layer": {
       "edges": [
        6,
        7,
        8,
        9,
        10
       ],
       "id": 2,
       "layout": {
        "placements": [
         {
          "nodeId": 9,
          "x": 0.5,
          "y": 0.12
         },
         {
          "nodeId": 10,
          "x": 0.22,
          "y": 0.38
         },
         {
          "nodeId": 11,
          "x": 0.16,
          "y": 0.72
         },
         {
          "nodeId": 12,
          "x": 0.78,
          "y": 0.38
         },
         {
          "nodeId": 13,
          "x": 0.84,
          "y": 0.72
         },
         {
          "nodeId": 14,
          "x": 0.5,
          "y": 0.88
         }
        ],
        "version": 1
       },
       "nodes": [
        9,
        10,
        11,
        12,
        13,
        14
       ],
       "state": "accepted"
      },
      "nodes": [
       {
        "detail": "**Prospective judgment** happens when you know time matters and monitor it as it passes. **Retrospective judgment** happens afterward, when you infer duration from memory. The same interval can therefore feel long in the moment but short in hindsight.",
        "icon": "arrow-right-left",
        "id": 9,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "The key difference"
       },
       {
        "detail": "You are asking, consciously or implicitly, **\u201cHow long is this taking?\u201d** Attention is crucial: the more attention you give to time itself, the longer the interval usually feels.\n\n**Example:** Waiting five minutes for a delayed train while repeatedly checking the clock can feel very long.",
        "icon": "monitor",
        "id": 10,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "Prospective: judging time now"
       },
       {
        "detail": "**Watched pot:** A dull meeting with the clock visible drags because attention keeps returning to elapsed time.\n\n**Absorbed activity:** An hour of an engaging game or conversation seems to fly because attention is directed away from time.",
        "icon": "bell",
        "id": 11,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "Prospective everyday contrast"
       },
       {
        "detail": "You are asking **\u201cHow long did that period seem?\u201d** without having monitored it closely. The judgment draws on memory: periods containing more changes, events, and distinctive landmarks often seem longer when recalled.\n\n**Example:** A routine workweek may feel brief on Sunday because its days blur together.",
        "icon": "database-backup",
        "id": 12,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "Retrospective: reconstructing time later"
       },
       {
        "detail": "**Routine week:** Repeated commutes and similar days leave few distinct memories, so the week looks compressed afterward.\n\n**Vacation week:** New places, foods, and activities create many memory landmarks, so the same seven days can feel expansive in retrospect.",
        "icon": "star",
        "id": 13,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "Retrospective everyday contrast"
       },
       {
        "detail": "A novel, absorbing vacation day may feel fast **while lived** because you are not watching the clock, yet long **when remembered** because it produced many memories. A boring, uneventful wait can show the reverse: slow now, but nearly absent from later memory.",
        "icon": "brain",
        "id": 14,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "The common paradox"
       }
      ]
     }
    },
    "completionError": null,
    "latestAttempt": null,
    "projectionFresh": true,
    "contexts": [],
    "submittedInputs": []
   }
  ]
 },
 "2": {
  "thread": {
   "id": 2,
   "title": "teach me how kimi delta attention works",
   "projectId": null,
   "rootInteractionId": 3,
   "harnessConfigurationName": "codex-basic",
   "harnessId": "codex-basic",
   "permissionProfileId": "auto",
   "createdAt": "1787853672231",
   "updatedAt": "1787853672231",
   "imported": true
  },
  "projectName": null,
  "producer": {
   "desktopVersion": "prototype",
   "platform": "darwin"
  },
  "interactions": [
   {
    "id": 3,
    "threadId": 2,
    "sequence": 1,
    "text": "teach me how kimi delta attention works",
    "createdAt": "1787853672231",
    "graphNodeId": 15,
    "completionStatus": "accepted",
    "harnessConfigurationName": "codex-basic",
    "modelSelection": {
     "providerId": "codex",
     "modelId": "gpt-5.6-luna"
    },
    "completionOutput": {
     "nodeId": 15,
     "rootAction": {
      "description": null,
      "icon": null,
      "id": 6,
      "interactionText": null,
      "kind": "navigate",
      "label": "Response",
      "relation": "expand",
      "sourceLayerId": null,
      "sourceNodeId": 15,
      "state": "accepted",
      "targetLayerId": 3,
      "variant": "pill"
     },
     "rootLayer": {
      "actions": [],
      "edges": [
       {
        "endpoints": [
         16,
         17
        ],
        "id": 11,
        "state": "accepted"
       },
       {
        "endpoints": [
         17,
         18
        ],
        "id": 12,
        "state": "accepted"
       },
       {
        "endpoints": [
         18,
         19
        ],
        "id": 13,
        "state": "accepted"
       },
       {
        "endpoints": [
         19,
         20
        ],
        "id": 14,
        "state": "accepted"
       },
       {
        "endpoints": [
         18,
         21
        ],
        "id": 15,
        "state": "accepted"
       }
      ],
      "layer": {
       "edges": [
        11,
        12,
        13,
        14,
        15
       ],
       "id": 3,
       "layout": {
        "placements": [
         {
          "nodeId": 16,
          "x": 0.12,
          "y": 0.5
         },
         {
          "nodeId": 17,
          "x": 0.3,
          "y": 0.5
         },
         {
          "nodeId": 18,
          "x": 0.48,
          "y": 0.5
         },
         {
          "nodeId": 19,
          "x": 0.66,
          "y": 0.5
         },
         {
          "nodeId": 20,
          "x": 0.86,
          "y": 0.5
         },
         {
          "nodeId": 21,
          "x": 0.48,
          "y": 0.8
         }
        ],
        "version": 1
       },
       "nodes": [
        16,
        17,
        18,
        19,
        20,
        21
       ],
       "state": "accepted"
      },
      "nodes": [
       {
        "detail": "Kimi Delta Attention is a linear-attention variant that keeps a compact recurrent state instead of forming every query\u2013key pair. It still retrieves from past information, but each new token updates the memory by correcting what the current key/value says the memory should contain.",
        "icon": "help-circle",
        "id": 16,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "The core idea"
       },
       {
        "detail": "Maintain a matrix-like state **S**. A key **k** addresses a direction in that state, while a value **v** is the content to associate with it. The output is read with the query: **y\u209c = S\u209c q\u209c**. The state is the compressed summary of the whole prefix.",
        "icon": "database",
        "id": 17,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "State as associative memory"
       },
       {
        "detail": "Instead of blindly adding **v\u209c k\u209c\u1d40**, first read the old prediction **S\u209c\u208b\u2081 k\u209c** and compute the error **v\u209c \u2212 S\u209c\u208b\u2081 k\u209c**. Then update: **S\u209c = S\u209c\u208b\u2081 + \u03b2\u209c (v\u209c \u2212 S\u209c\u208b\u2081 k\u209c) k\u209c\u1d40**. This writes only the correction needed to make key **k\u209c** retrieve value **v\u209c**; **\u03b2\u209c** controls write strength.",
        "icon": "rotate-ccw",
        "id": 18,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "The delta update"
       },
       {
        "detail": "For each token, project to q\u209c, k\u209c, and v\u209c, read **y\u209c = S\u209c q\u209c**, then apply the delta update. The state is carried forward once per token, so work and memory grow roughly linearly with sequence length rather than quadratically with all token pairs.",
        "icon": "workflow",
        "id": 19,
        "kind": "process",
        "leasedActionId": null,
        "state": "accepted",
        "title": "A linear-time scan"
       },
       {
        "detail": "Full softmax attention keeps token-to-token interactions and offers flexible content-based lookup, but costs O(L\u00b2) during a long context. Kimi Delta Attention trades some flexibility for O(L) recurrent processing and a fixed-size state, making it attractive for long sequences and streaming inference.",
        "icon": "git-compare",
        "id": 20,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "Compared with softmax attention"
       },
       {
        "detail": "Think of the state as a notebook of key\u2192value associations. A new observation does not append a duplicate note; it checks what the notebook currently predicts for that key and edits the mismatch. This is why it is called **delta** attention: the write is an error-correction delta.",
        "icon": "brain",
        "id": 21,
        "kind": "concept",
        "leasedActionId": null,
        "state": "accepted",
        "title": "A useful mental model"
       }
      ]
     }
    },
    "completionError": null,
    "latestAttempt": null,
    "projectionFresh": true,
    "contexts": [],
    "submittedInputs": []
   }
  ]
 }
};
