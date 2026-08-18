import { Codex } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EdgeObject, LayerObject, NodeObject, RelayerGraphClient, type CompletionOutput, type GraphCapability, type GraphNode } from "@relayer/graph-client";
import { loadHarnessConfiguration, productHarnessImplementations, startHarnessHost, type Harness, type HarnessConfiguration, type HarnessFactory, type HarnessSessionState } from "@relayer/harness-host";

export const basicEvalPrompt = "A task system has an incoming queue, two workers, and a results store. Explain how a task moves through the system and what happens when both workers are busy.";
export const basicEvalFollowUpPrompt = "Follow up in the same thread: explain the task flow again, emphasizing what happens while both workers are busy and immediately after one worker finishes.";
const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const fixtureHarnessConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "fixture-task-system",
  implementation: "fixture.task-system",
  implementationVersion: 1,
  settings: {},
};

export const basicEvalFacts = [
  { id: "enters-queue", description: "Tasks enter the incoming queue.", patterns: [/task.{0,30}(enter|arriv).{0,30}queue/i, /incoming queue/i] },
  { id: "worker-claims", description: "An available worker claims a queued task.", patterns: [/worker.{0,40}(claim|take|pull|pick)/i] },
  { id: "two-active-limit", description: "At most two tasks can be active.", patterns: [/(at most|maximum|max|up to).{0,15}two/i, /two.{0,20}(active|concurrent|workers)/i, /both.{0,30}busy.{0,30}no new task (starts|can start)/i] },
  { id: "wait-when-busy", description: "Additional tasks wait while both workers are busy.", patterns: [/(wait|remain|stay).{0,35}queue/i, /both workers.{0,35}busy/i] },
  { id: "write-result", description: "A completed task is written to the results store.", patterns: [/(result|output).{0,35}(store|write|save)/i, /(store|write|save).{0,35}(result|output)/i] },
  { id: "claim-next", description: "A freed worker claims the next queued task.", patterns: [/(free|available|finish).{0,45}(next|queue)/i, /(next).{0,35}(worker|claim|task)/i] },
] as const;

export interface EvalCheck { readonly name: string; readonly passed: boolean; readonly detail: string }
export interface RuntimeEvalTurn {
  readonly interactionNodeId: number;
  readonly prompt: string;
  readonly output: CompletionOutput;
  readonly checks: readonly EvalCheck[];
  readonly judge?: BasicJudge;
  readonly passed: boolean;
}
export interface RuntimeEvalArtifact {
  readonly schemaVersion: 2;
  readonly caseId: "empty-project.task-system.two-turn";
  readonly runId: string;
  readonly createdAt: string;
  readonly harness: string;
  readonly turns: readonly RuntimeEvalTurn[];
  readonly sessionChecks: readonly EvalCheck[];
  readonly deterministicPassed: boolean;
  readonly passed: boolean;
}
export interface BasicJudge { readonly factIds: readonly string[]; readonly graphUseful: boolean; readonly detailsUseful: boolean; readonly problems: readonly string[]; readonly verdict: "pass" | "fail" }

class TaskSystemFixtureHarness implements Harness {
  constructor(private graph: RelayerGraphClient) {}
  setGraphCapability(graph: GraphCapability): void { this.graph = new RelayerGraphClient(graph); }
  state(): HarnessSessionState { return {}; }
  async complete(interaction: GraphNode): Promise<CompletionOutput> {
    const queue = new NodeObject("queue", "Incoming queue", "Every task first enters the incoming queue. The queue preserves extra work while both workers are busy.", "concept", "queue");
    const workers = new NodeObject("workers", "Two-worker pool", "An available worker claims the next queued task. At most two tasks run concurrently; additional tasks wait until a worker finishes.", "concept", "workers");
    const results = new NodeObject("database", "Results store", "When a worker completes a task, it writes the output to the results store. The freed worker then claims the next task from the queue.", "concept", "results");
    await this.graph.submitNode(queue); await this.graph.submitNode(workers); await this.graph.submitNode(results);
    const queueWorkers = new EdgeObject([queue, workers], "queue-workers");
    const workersResults = new EdgeObject([workers, results], "workers-results");
    await this.graph.createEdge(queueWorkers); await this.graph.createEdge(workersResults);
    const layer = new LayerObject([queue, workers, results], [queueWorkers, workersResults], "root-layer");
    await this.graph.submitLayer(layer);
    await this.graph.addAction(interaction.id, { kind: "navigate", label: "Response", target: layer, response: true, clientKey: "response" });
    return this.graph.submit(interaction.id);
  }
}

export async function runBasicRuntimeEval(options: { outputDirectory: string; live: boolean; judge?: boolean; serverBinary?: string; serverReadyTimeoutMs?: number }): Promise<RuntimeEvalArtifact> {
  const runId = randomUUID();
  const workingDirectory = await mkdtemp(join(tmpdir(), "relayer-runtime-eval-"));
  const stateDirectory = join(workingDirectory, "state");
  const controlToken = randomUUID();
  let graphProcess: Awaited<ReturnType<typeof startGraphServer>> | undefined;
  let harnessHost: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
  try {
    graphProcess = await startGraphServer(options.serverBinary, join(stateDirectory, "graph.sqlite"), controlToken, options.serverReadyTimeoutMs);
    const projectId = 1;
    const threadId = 1;
    let harnessFactoryCalls = 0;
    const fixtureFactory: HarnessFactory = (context) => new TaskSystemFixtureHarness(new RelayerGraphClient(context.graph));
    const configuration = options.live
      ? await loadHarnessConfiguration(join(repositoryRoot, "harnesses/codex-basic.yaml"))
      : fixtureHarnessConfiguration;
    const registeredImplementations = productHarnessImplementations({ "fixture.task-system": fixtureFactory });
    const selectedFactory = registeredImplementations[configuration.implementation];
    if (selectedFactory === undefined) throw new Error(`Unknown eval harness implementation: ${configuration.implementation}`);
    const implementations = {
      ...registeredImplementations,
      [configuration.implementation]: ((context) => {
        harnessFactoryCalls += 1;
        return selectedFactory(context);
      }) satisfies HarnessFactory,
    };
    harnessHost = await startHarnessHost({ implementations, stateFile: join(stateDirectory, "harness-sessions.json"), controlToken });

    const capabilities: GraphCapability[] = [];
    const turns: RuntimeEvalTurn[] = [];
    for (const prompt of [basicEvalPrompt, basicEvalFollowUpPrompt]) {
      const interaction = await requestJson<{ node: GraphNode; graphToken: string }>(`${graphProcess.url}/api/control/interactions`, controlToken, { projectId, threadId, text: prompt });
      const capability = { url: graphProcess.url, token: interaction.graphToken, nodeId: interaction.node.id };
      capabilities.push(capability);
      await requestJson(`${harnessHost.url}/sessions`, controlToken, { threadId, configuration, workingDirectory, graph: capability }, 201);
      const complete = await requestJson<{ output: CompletionOutput }>(`${harnessHost.url}/sessions/${threadId}/complete`, controlToken, { nodeId: interaction.node.id });
      const checks = checkBasicOutput(complete.output, interaction.node.id);
      const deterministicPassed = checks.every((check) => check.passed);
      const judge = options.judge && deterministicPassed ? await judgeOutput(complete.output, prompt, workingDirectory) : undefined;
      turns.push({
        interactionNodeId: interaction.node.id,
        prompt,
        output: complete.output,
        checks,
        ...(judge === undefined ? {} : { judge }),
        passed: deterministicPassed && (judge === undefined || judge.verdict === "pass"),
      });
    }
    const sessionChecks: EvalCheck[] = [
      { name: "single-harness-object", passed: harnessFactoryCalls === 1, detail: `Harness factory called ${harnessFactoryCalls} time${harnessFactoryCalls === 1 ? "" : "s"} for two interactions.` },
      { name: "rotated-interaction-capability", passed: capabilities.length === 2 && capabilities[0]!.nodeId !== capabilities[1]!.nodeId && capabilities[0]!.token !== capabilities[1]!.token, detail: "The second interaction used a distinct node and opaque capability token." },
    ];
    const deterministicPassed = sessionChecks.every((check) => check.passed) && turns.every((turn) => turn.checks.every((check) => check.passed));
    const passed = deterministicPassed && turns.every((turn) => turn.passed);
    const artifact: RuntimeEvalArtifact = { schemaVersion: 2, caseId: "empty-project.task-system.two-turn", runId, createdAt: new Date().toISOString(), harness: configuration.name, turns, sessionChecks, deterministicPassed, passed };
    const runDirectory = join(resolve(options.outputDirectory), runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "result.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await writeFile(join(runDirectory, "index.html"), renderArtifact(artifact), "utf8");
    return artifact;
  } finally {
    await harnessHost?.close();
    if (graphProcess !== undefined) {
      graphProcess.process.kill("SIGTERM");
      await onceExit(graphProcess.process);
    }
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

export function checkBasicOutput(output: CompletionOutput, expectedInteractionNodeId = output.nodeId): EvalCheck[] {
  const layer = output.rootLayer;
  const declaredNodeIds = layer.layer.nodes;
  const resolvedNodeIds = layer.nodes.map((node) => node.id);
  const declaredEdgeIds = layer.layer.edges;
  const resolvedEdgeIds = layer.edges.map((edge) => edge.id);
  const nodeIds = new Set(layer.nodes.map((node) => node.id));
  const adjacency = new Map(layer.nodes.map((node) => [node.id, new Set<number>()]));
  for (const edge of layer.edges) { adjacency.get(edge.endpoints[0])?.add(edge.endpoints[1]); adjacency.get(edge.endpoints[1])?.add(edge.endpoints[0]); }
  const visited = new Set<number>(); const pending = layer.nodes[0] === undefined ? [] : [layer.nodes[0].id];
  while (pending.length) { const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id); pending.push(...(adjacency.get(id) ?? [])); }
  const text = layer.nodes.map((node) => `${node.title}\n${node.detail}`).join("\n");
  const facts = basicEvalFacts.map((fact) => ({ name: `fact:${fact.id}`, passed: fact.patterns.some((pattern) => pattern.test(text)), detail: fact.description }));
  return [
    { name: "interaction-output", passed: output.nodeId === expectedInteractionNodeId && output.rootAction.sourceNodeId === expectedInteractionNodeId, detail: "Completion output and response action belong to the requested interaction." },
    { name: "accepted-closure", passed: output.rootAction.state === "accepted" && layer.layer.state === "accepted" && layer.nodes.every((node) => node.state === "accepted") && layer.edges.every((edge) => edge.state === "accepted") && layer.actions.every((action) => action.state === "accepted"), detail: "The response action and complete visible closure are accepted." },
    { name: "resolved-membership", passed: arraysEqual(declaredNodeIds, resolvedNodeIds) && arraysEqual(declaredEdgeIds, resolvedEdgeIds), detail: "Resolved records exactly match the accepted layer references." },
    { name: "response-action", passed: output.rootAction.kind === "navigate" && output.rootAction.response && output.rootAction.targetLayerId === layer.layer.id, detail: "Interaction has one accepted response navigate action." },
    { name: "visible-layer", passed: layer.nodes.length >= 1 && layer.nodes.length <= 8 && layer.nodes.every((node) => node.icon.trim() && node.title.trim() && node.detail.trim()), detail: `${layer.nodes.length} complete visible nodes.` },
    { name: "exact-edges", passed: layer.edges.every((edge) => edge.endpoints[0] !== edge.endpoints[1] && nodeIds.has(edge.endpoints[0]) && nodeIds.has(edge.endpoints[1])), detail: `${layer.edges.length} visible undirected edges stay inside the layer.` },
    { name: "connected", passed: visited.size === layer.nodes.length, detail: `${visited.size}/${layer.nodes.length} nodes connected.` },
    ...facts,
  ];
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const judgeSchema = { type: "object", properties: { factIds: { type: "array", items: { type: "string" } }, graphUseful: { type: "boolean" }, detailsUseful: { type: "boolean" }, problems: { type: "array", items: { type: "string" } }, verdict: { type: "string", enum: ["pass", "fail"] } }, required: ["factIds", "graphUseful", "detailsUseful", "problems", "verdict"], additionalProperties: false } as const;
async function judgeOutput(output: CompletionOutput, promptText: string, workingDirectory: string): Promise<BasicJudge> {
  const codex = new Codex(); const thread = codex.startThread({ workingDirectory, skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false });
  const visible = judgeVisibleGraph(output);
  const prompt = `Grade this visible graph answer to: ${promptText}\nExpected facts:\n${basicEvalFacts.map((fact)=>`${fact.id}: ${fact.description}`).join("\n")}\nGraph: ${JSON.stringify(visible)}\nList only fact IDs clearly present. Pass only when all six facts are present, graph connections are useful, details are useful, and there are no problems.`;
  const turn = await thread.run(prompt, { outputSchema: judgeSchema });
  const value = JSON.parse(turn.finalResponse) as BasicJudge;
  const expected = new Set(basicEvalFacts.map((fact) => fact.id)); const actual = new Set(value.factIds);
  const valid = expected.size === actual.size && [...expected].every((id) => actual.has(id)) && value.graphUseful && value.detailsUseful && value.problems.length === 0;
  return { ...value, verdict: valid ? "pass" : "fail" };
}

export function judgeVisibleGraph(output: CompletionOutput): { nodes: readonly { id: number; icon: string; title: string; detail: string }[]; edges: readonly (readonly [number, number])[] } {
  return { nodes: output.rootLayer.nodes.map(({ id, icon, title, detail }) => ({ id, icon, title, detail })), edges: output.rootLayer.edges.map((edge) => edge.endpoints) };
}

async function startGraphServer(binary: string | undefined, database: string, controlToken: string, readyTimeoutMs = 10_000): Promise<{ url: string; process: ChildProcessWithoutNullStreams }> {
  const executable = resolve(binary ?? process.env.RELAYER_GRAPH_SERVER_BIN ?? join(repositoryRoot, "target/debug/relayer-graph-server"));
  try { await access(executable); } catch { throw new Error(`Rust graph server not found at ${executable}. Run: cargo build -p relayer-graph-server`); }
  await mkdir(resolve(database, ".."), { recursive: true });
  const child = spawn(executable, ["--database", database, "--control-token", controlToken, "--port", "0"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const line = await firstLine(child, readyTimeoutMs);
    const ready = JSON.parse(line) as { url?: string };
    if (!ready.url) throw new Error(`Graph server returned an invalid readiness line: ${line}`);
    return { url: ready.url, process: child };
  } catch (error) {
    await terminate(child);
    throw error;
  }
}
function firstLine(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> { return new Promise((resolveLine,reject)=>{let value="";const timer=setTimeout(()=>{cleanup();reject(new Error(`Graph server did not become ready within ${timeoutMs}ms`));},timeoutMs);const onData=(chunk:Buffer)=>{value+=chunk.toString();const index=value.indexOf("\n");if(index>=0){cleanup();resolveLine(value.slice(0,index));}};const onExit=(code:number|null)=>{cleanup();reject(new Error(`Graph server exited before ready (${code})`));};const onError=(error:Error)=>{cleanup();reject(new Error(`Graph server could not start: ${error.message}`,{cause:error}));};const cleanup=()=>{clearTimeout(timer);child.stdout.off("data",onData);child.off("exit",onExit);child.off("error",onError);};child.stdout.on("data",onData);child.once("exit",onExit);child.once("error",onError);}); }
function onceExit(child: ChildProcessWithoutNullStreams): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(); return new Promise((resolveExit)=>child.once("exit",()=>resolveExit())); }
async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = onceExit(child);
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), 1_000); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
}
async function requestJson<T=unknown>(url:string,token:string,body:unknown,expected=200):Promise<T>{const response=await fetch(url,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});const value=await response.json();if(response.status!==expected)throw new Error(`Request ${url} failed (${response.status}): ${JSON.stringify(value)}`);return value as T;}

export function renderArtifact(artifact: RuntimeEvalArtifact): string {
  const data = JSON.stringify(artifact).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(artifact.caseId)}</title>
  <style>
    body{margin:0;background:#111317;color:#edf0f5;font:14px system-ui}
    .bar{padding:18px 24px;border-bottom:1px solid #343842}
    .summary{display:flex;align-items:center;gap:8px}
    .turns{display:flex;align-items:center;gap:10px;margin-top:12px}
    button{background:#242832;border:1px solid #555b69;border-radius:8px;color:#edf0f5;padding:5px 10px;cursor:pointer}
    button:disabled{cursor:default;opacity:.4}
    .prompt{margin-top:10px;color:#c9cfda}
    .stage{height:64vh;position:relative}
    .node{position:absolute;width:180px;padding:14px;background:#1d2027;border:1px solid #555b69;border-radius:14px;transform:translate(-50%,-50%);cursor:grab}
    .node b{display:block;margin-top:7px}
    .node small{color:#aeb5c3}
    svg{position:absolute;inset:0;width:100%;height:100%}
    line{stroke:#7b8395;stroke-width:2}
    .checks{padding:18px 24px}
    .pass{color:#68d391}
    .fail{color:#fc8181}
  </style>
</head>
<body>
  <div class="bar">
    <div class="summary"><b>${escapeHtml(artifact.caseId)}</b> · <span class="${artifact.passed ? "pass" : "fail"}">${artifact.passed ? "PASS" : "FAIL"}</span></div>
    <div class="turns"><button id="previous" aria-label="Previous turn">←</button><span id="turn-label"></span><button id="next" aria-label="Next turn">→</button></div>
    <div class="prompt" id="prompt"></div>
  </div>
  <div class="stage" id="stage"><svg id="edges"></svg></div>
  <div class="checks" id="checks"></div>
  <script>
    const artifact=${data};
    const stage=document.querySelector('#stage');
    const edgeCanvas=document.querySelector('#edges');
    const previous=document.querySelector('#previous');
    const next=document.querySelector('#next');
    let turnIndex=0;
    let nodes=[];
    let edges=[];

    previous.onclick=()=>{if(turnIndex>0){turnIndex-=1;render()}};
    next.onclick=()=>{if(turnIndex<artifact.turns.length-1){turnIndex+=1;render()}};

    function render(){
      const turn=artifact.turns[turnIndex];
      previous.disabled=turnIndex===0;
      next.disabled=turnIndex===artifact.turns.length-1;
      document.querySelector('#turn-label').textContent='Turn '+(turnIndex+1)+' of '+artifact.turns.length;
      document.querySelector('#prompt').textContent=turn.prompt;
      document.querySelectorAll('.node').forEach((node)=>node.remove());
      edgeCanvas.replaceChildren();
      nodes=turn.output.rootLayer.nodes.map((node,index)=>({...node,x:innerWidth/2+Math.cos(index*6.28/turn.output.rootLayer.nodes.length)*220,y:stage.clientHeight/2+Math.sin(index*6.28/turn.output.rootLayer.nodes.length)*150}));
      edges=turn.output.rootLayer.edges;
      for(const node of nodes){
        const element=document.createElement('div');
        const icon=document.createElement('span');
        const title=document.createElement('b');
        const detail=document.createElement('small');
        element.className='node';
        element.dataset.id=node.id;
        icon.textContent=node.icon;
        title.textContent=node.title;
        detail.textContent=node.detail;
        element.append(icon,title,detail);
        stage.append(element);
        element.onpointerdown=(event)=>{
          element.setPointerCapture(event.pointerId);
          element.onpointermove=(move)=>{node.x=move.clientX;node.y=move.clientY-stage.getBoundingClientRect().top;draw()};
        };
      }
      const checks=document.querySelector('#checks');
      checks.replaceChildren();
      for(const check of [...artifact.sessionChecks,...turn.checks]){
        const row=document.createElement('div');
        row.className=check.passed?'pass':'fail';
        row.textContent=(check.passed?'✓ ':'✕ ')+check.name+' — '+check.detail;
        checks.append(row);
      }
      draw();
    }

    function draw(){
      for(const node of nodes){
        const element=stage.querySelector('[data-id="'+node.id+'"]');
        element.style.left=node.x+'px';
        element.style.top=node.y+'px';
      }
      edgeCanvas.replaceChildren(...edges.map((edge)=>{
        const left=nodes.find((node)=>node.id===edge.endpoints[0]);
        const right=nodes.find((node)=>node.id===edge.endpoints[1]);
        const line=document.createElementNS('http://www.w3.org/2000/svg','line');
        line.setAttribute('x1',left.x);line.setAttribute('y1',left.y);line.setAttribute('x2',right.x);line.setAttribute('y2',right.y);
        return line;
      }));
    }

    render();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function argument(name:string):string|undefined{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];}
async function main():Promise<void>{const live=process.argv.includes("--live");const artifact=await runBasicRuntimeEval({outputDirectory:resolve(argument("--output-dir")??".relayer/evals/runtime"),live,judge:live&&!process.argv.includes("--no-judge")});console.log(JSON.stringify({runId:artifact.runId,harness:artifact.harness,passed:artifact.passed,viewer:resolve(argument("--output-dir")??".relayer/evals/runtime",artifact.runId,"index.html")}));if(!artifact.passed)process.exitCode=1;}
if(process.argv[1]!==undefined&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void main();
