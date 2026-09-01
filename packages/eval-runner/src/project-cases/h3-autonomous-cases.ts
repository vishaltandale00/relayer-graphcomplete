import { createHash } from "node:crypto";

import { bindAutonomousCaseSnapshot } from "../cases/catalog.js";
import { createAutonomousCaseSnapshot } from "../cases/contracts.js";
import {
  H3_REPOSITORY_URL,
  H3_SEEDED_TREE,
  h3VerifierDigest,
  h3AutonomousFixEvalCase,
  h3AutonomousFixMultiTurnEvalCase,
  h3AutonomousInvestigationEvalCase,
} from "./h3.js";

const digest = (value: string) => `sha256:${value}` as const;
const hashText = (value: string) => digest(createHash("sha256").update(value).digest("hex"));
const workspace = Object.freeze({
  kind: "frozen-workspace" as const,
  materializerId: "h3-seeded-status-code-v1",
  source: H3_REPOSITORY_URL,
  revision: `git-tree:${H3_SEEDED_TREE}`,
  contentDigest: digest("abbd161e235f1c322b384a16864fe2b9473433d9d8a4577c8fc050d242130172"),
  environmentDigest: digest("4ac152088cd2016a02464618f3305c81deedffc2741282f0f0446cc343c739c0"),
});

const h3FixReference = Object.freeze({
  kind: "sealed-reference" as const,
  artifactId: "h3-status-code-reference-v1",
  format: "git-patch" as const,
  contentDigest: digest("878b3d93f4d37972c5bd79e028697b851b9857daa0f9975f035f50244116453c"),
  sealedPath: "eval-cases/h3-sanitize-status-code/solution/reference.patch",
});

const h3FixVerifier = Object.freeze({
  kind: "sealed-verifier" as const,
  artifactId: "h3-status-code-verifier-v2",
  verifierId: "h3-status-code-v2",
  contentDigest: h3VerifierDigest(),
  sealedPath: "packages/eval-runner/src/project-cases/h3.ts",
  mandatoryGates: [
    { id: "functional-behavior", label: "Functional behavior", description: "Evaluator-owned checks cover boundaries, numbers, numeric strings, decimals, and custom fallbacks." },
    { id: "regression-safety", label: "Regression safety", description: "The focused sanitizer suite, build, and typecheck pass in the pristine verifier workspace." },
    { id: "scoped-clean-commit", label: "Scoped clean commit", description: "The repair is committed, focused, and leaves a clean tree." },
  ],
});

const h3FixOutcomeRubric = Object.freeze({
  kind: "outcome-rubric" as const,
  rubricVersion: "h3-fix-outcome-v1",
  contentDigest: digest("031da0d2a80f22e5ce42b919d2ea86455ae63e0d70f07136ac45baf932d09b14"),
  criteria: [
    { id: "behavior", label: "Behavioral correctness", description: "The repair handles the requested cases without regressions.", weight: 3 },
    { id: "scope-quality", label: "Implementation quality", description: "The implementation and tests are appropriately scoped and maintainable.", weight: 1 },
  ],
});

export const h3AutonomousFixCase = bindAutonomousCaseSnapshot(
  h3AutonomousFixEvalCase,
  createAutonomousCaseSnapshot({
    id: h3AutonomousFixEvalCase.id,
    name: h3AutonomousFixEvalCase.name,
    description: h3AutonomousFixEvalCase.description,
    category: "coding",
    taskType: "debugging",
    artifacts: {
      task: {
        kind: "visible-task",
        text: h3AutonomousFixEvalCase.threads[0]!.prompts[0]!,
        contentDigest: digest("0014f375208f33a799eeb895d670028aa65210c3218f5a96e5b5e9161f42ddd3"),
      },
      workspace,
      reference: h3FixReference,
      verifier: h3FixVerifier,
      outcomeRubric: h3FixOutcomeRubric,
    },
  }),
);

export const h3AutonomousFixMultiTurnCase = bindAutonomousCaseSnapshot(
  h3AutonomousFixMultiTurnEvalCase,
  createAutonomousCaseSnapshot({
    id: h3AutonomousFixMultiTurnEvalCase.id,
    name: h3AutonomousFixMultiTurnEvalCase.name,
    description: h3AutonomousFixMultiTurnEvalCase.description,
    category: "coding",
    taskType: "debugging",
    artifacts: {
      task: {
        kind: "visible-task",
        text: h3AutonomousFixMultiTurnEvalCase.threads[0]!.prompts[0]!,
        contentDigest: hashText(h3AutonomousFixMultiTurnEvalCase.threads[0]!.prompts[0]!),
      },
      workspace,
      reference: h3FixReference,
      verifier: h3FixVerifier,
      outcomeRubric: h3FixOutcomeRubric,
    },
  }),
);

export const h3AutonomousInvestigationCase = bindAutonomousCaseSnapshot(
  h3AutonomousInvestigationEvalCase,
  createAutonomousCaseSnapshot({
    id: h3AutonomousInvestigationEvalCase.id,
    name: h3AutonomousInvestigationEvalCase.name,
    description: h3AutonomousInvestigationEvalCase.description,
    category: "work",
    taskType: "investigation",
    artifacts: {
      task: {
        kind: "visible-task",
        text: h3AutonomousInvestigationEvalCase.threads[0]!.prompts[0]!,
        contentDigest: digest("5da5bb956af8bf4563fc2799b84322852f523c2144c5d8a7d62ad38ef6c89ce3"),
      },
      workspace,
      reference: {
        kind: "sealed-reference",
        artifactId: "h3-investigation-reference-v1",
        format: "markdown",
        contentDigest: digest("ebbf43e58e45600dcff5381505557a9a9ee303a94452044358eebc3397dc421e"),
        sealedPath: "eval-cases/h3-investigate-status-code/solution/reference.md",
      },
      verifier: {
        kind: "sealed-verifier",
        artifactId: "h3-investigation-verifier-v1",
        verifierId: "h3-status-code-investigation-v1",
        contentDigest: h3VerifierDigest(),
        sealedPath: "packages/eval-runner/src/project-cases/h3.ts",
        mandatoryGates: [
          { id: "read-only-workspace", label: "Read-only workspace", description: "The investigation does not alter the frozen checkout." },
          { id: "independent-reproduction", label: "Independent reproduction", description: "The sealed verifier reproduces the seeded failure independently of the candidate explanation." },
        ],
      },
      outcomeRubric: {
        kind: "outcome-rubric",
        rubricVersion: "h3-investigation-outcome-v1",
        contentDigest: digest("73bc8dedeaf023236b495138b0264461dba2f6c6307139781eab26ce9c275c5c"),
        criteria: [
          { id: "diagnosis", label: "Diagnostic correctness", description: "The explanation identifies the responsible path and boundary.", weight: 3 },
          { id: "evidence", label: "Evidence quality", description: "Claims are grounded in exact code and reproducible evidence.", weight: 1 },
        ],
      },
    },
  }),
);

export const h3AutonomousCases = Object.freeze([
  h3AutonomousFixCase,
  h3AutonomousFixMultiTurnCase,
  h3AutonomousInvestigationCase,
]);
