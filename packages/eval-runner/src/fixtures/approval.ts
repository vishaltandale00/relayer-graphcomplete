import { LayerObject, NodeObject, RelayerGraphClient } from "@relayer/graph-client";
import type {
  Harness,
  HarnessApprovalDecision,
  HarnessConfiguration,
  HarnessFactory,
  HarnessFactoryContext,
  HarnessRunContext,
  HarnessSessionState,
} from "@relayer/harness-host";

export const approvalFixtureConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "fixture-approval",
  implementation: "fixture.approval",
  implementationVersion: 1,
  permissionBindings: { ask: {} },
  settings: {},
};

export interface ApprovalFixtureObservation {
  readonly completion: number;
  readonly step: string;
  readonly decision: HarnessApprovalDecision["decision"];
  readonly actor: HarnessApprovalDecision["actor"];
  readonly protectedActionExecuted: boolean;
}

export interface ApprovalFixtureDependencies {
  readonly observe?: (observation: ApprovalFixtureObservation) => void;
}

class ApprovalFixtureHarness implements Harness {
  private completionCount: number;

  constructor(
    private readonly context: HarnessFactoryContext,
    private readonly dependencies: ApprovalFixtureDependencies,
  ) {
    const savedCount = context.savedState?.completionCount;
    this.completionCount = Number.isSafeInteger(savedCount) && Number(savedCount) >= 0
      ? Number(savedCount)
      : 0;
  }

  state(): HarnessSessionState {
    return { completionCount: this.completionCount };
  }

  async complete(context: HarnessRunContext): Promise<void> {
    this.completionCount += 1;
    const completion = this.completionCount;
    const summary = completion === 1
      ? "The deterministic baseline completed without additional authority."
      : completion === 2
        ? await this.approveOnceThenDeny(context, completion)
        : completion === 3
          ? await this.approveAlwaysQueue(context, completion)
          : await this.consumeSessionGrant(context, completion);
    await this.acceptGraph(context, completion, summary);
  }

  private async approveOnceThenDeny(context: HarnessRunContext, completion: number): Promise<string> {
    const first = await this.request(context, completion, "once-first", TEST_SCOPE_KEYS, "npm test");
    this.observe(completion, "once-first", first);
    const repeated = await this.request(context, completion, "once-repeated", TEST_SCOPE_KEYS, "npm test");
    this.observe(completion, "once-repeated", repeated);
    return repeated.decision === "deny"
      ? "Approve once executed only the displayed request. The repeated request was denied, so the same turn adapted without executing it."
      : "The repeated request received a direct decision from the user."
  }

  private async approveAlwaysQueue(context: HarnessRunContext, completion: number): Promise<string> {
    const source = this.request(context, completion, "always-source", BUILD_SCOPE_KEYS, "npm run build");
    // Make the user-selected source request deterministically first in the product queue;
    // this is fixture orchestration, not an approval timeout.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const exactPending = this.request(context, completion, "always-exact-pending", BUILD_SCOPE_KEYS, "npm run build");
    const nearPending = this.request(context, completion, "always-near-pending", DEPLOY_SCOPE_KEYS, "npm run deploy");
    const [sourceDecision, exactDecision, nearDecision] = await Promise.all([source, exactPending, nearPending]);
    this.observe(completion, "always-source", sourceDecision);
    this.observe(completion, "always-exact-pending", exactDecision);
    this.observe(completion, "always-near-pending", nearDecision);
    return "Approve always covered only the exact pending build request. The near deploy request remained independently actionable."
  }

  private async consumeSessionGrant(context: HarnessRunContext, completion: number): Promise<string> {
    const exactFuture = await this.request(context, completion, "always-exact-future", BUILD_SCOPE_KEYS, "npm run build");
    this.observe(completion, "always-exact-future", exactFuture);
    return "The exact build request reused the live-session grant across completions without making the grant durable product state."
  }

  private request(
    context: HarnessRunContext,
    completion: number,
    step: string,
    scopeKeys: readonly string[],
    command: string,
  ): Promise<HarnessApprovalDecision> {
    return context.approvals.request({
      providerItemId: `fixture-provider-${completion}-${step}`,
      title: `Allow ${command}`,
      reason: `The deterministic fixture requested ${command}.`,
      action: { kind: "command", command, workingDirectory: this.context.workingDirectory },
      scopeKeys,
      scopeDescription: `Run ${command} in ${this.context.workingDirectory} for this live harness session.`,
    });
  }

  private observe(completion: number, step: string, decision: HarnessApprovalDecision): void {
    this.dependencies.observe?.({
      completion,
      step,
      decision: decision.decision,
      actor: decision.actor,
      protectedActionExecuted: decision.decision !== "deny",
    });
  }

  private async acceptGraph(context: HarnessRunContext, completion: number, detail: string): Promise<void> {
    const graph = new RelayerGraphClient(context.graph.acquireCapability());
    const node = new NodeObject(
      "shield-check",
      `Approval fixture ${completion}`,
      detail,
      "result",
      `approval-fixture-result-${completion}`,
    );
    await graph.submitNode(node);
    const layer = new LayerObject([node], [], `approval-fixture-layer-${completion}`);
    await graph.submitLayer(layer);
    await graph.addAction(context.inputGraph.id, {
      kind: "navigate",
      relation: "expand",
      label: "Response",
      target: layer,
      clientKey: `approval-fixture-response-${completion}`,
    });
    await graph.submit(context.inputGraph.id);
  }
}

const TEST_SCOPE_KEYS = Object.freeze(["fixture:command:npm-test", "fixture:cwd:workspace"]);
const BUILD_SCOPE_KEYS = Object.freeze(["fixture:command:npm-build", "fixture:cwd:workspace"]);
const DEPLOY_SCOPE_KEYS = Object.freeze(["fixture:command:npm-deploy", "fixture:cwd:workspace"]);

export function createApprovalFixtureFactory(dependencies: ApprovalFixtureDependencies = {}): HarnessFactory {
  return (context) => new ApprovalFixtureHarness(context, dependencies);
}

export const approvalFixtureFactory = createApprovalFixtureFactory();
