import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PrimeAgentHarness } from "../../packages/harness-host/dist/implementations/prime-agent.js";

// Replaces inference only. The real factory, run context, Python client, compiler,
// authenticated graph/asset routes and Rust acceptance remain in the path.
export function primeVisualFixtureFactory(context, { pinnedStructure = false } = {}) {
  return PrimeAgentHarness.create(context, { loadModule: async () => {
    const nativeKernel = process.env.RELAYER_TEST_PRIME_PYTHON
      ? await import(new URL("./core/kernel/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href)
      : undefined;
    return ({
    AGENT_RUN_MODEL_SCOPE_VERSION: 1,
    createAgentRunModelScope: (input) => input,
    SessionManager: {
      create: (cwd, managedSessionDir) => {
        const directory = managedSessionDir ?? join(cwd, ".prime-visual-fixture-sessions");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const sessionFile = join(directory, `${randomUUID()}.json`);
        const history = { schemaVersion: 1, threadId: context.threadId, prompts: [] };
        writeFileSync(sessionFile, JSON.stringify(history), { mode: 0o600 });
        return { sessionFile, history };
      },
    },
    createHostRequestHandler: nativeKernel?.createHostRequestHandler ?? ((handler) => handler),
    createAgentSessionServices: async () => ({ resourceLoader: { getAppendSystemPrompt: () => [] } }),
    createAgentSessionFromServices: async ({ hostRequestHandlers, sessionManager }) => {
      let process;
      const persistPrompt = (prompt) => {
        sessionManager.history.prompts.push(prompt);
        writeFileSync(sessionManager.sessionFile, JSON.stringify(sessionManager.history), { mode: 0o600 });
      };
      return { session: {
        sessionFile: sessionManager.sessionFile,
        agent: { state: { thinkingLevel: "off" } },
        sessionManager: { appendThinkingLevelChange() {} },
        async promptAndWait(prompt, { runContext }) {
          let python = PYTHON;
          if (prompt.includes("Authored visual Node Details:")) {
            if (/detailAuthoring|checkpointNodeDetail|detailCapability|html`/.test(prompt)) {
              throw new Error("Prime V3 prompt contains TypeScript authoring instructions");
            }
            const pinned = pinnedStructure && prompt.startsWith("You are the Relayer Prime instruction-graph-v2 harness.");
            const manifest = pinned ? JSON.parse(prompt.split("Pinned instruction directory (metadata only):\n")[1].split("\n")[0]) : undefined;
            const example = pinned
              ? `import json\nexpected_manifest = json.loads(${JSON.stringify(JSON.stringify(manifest))})\n${PINNED_STRUCTURE}`
              : prompt.match(/```python\n([\s\S]*?)\n```/)?.[1];
            if (!example) throw new Error("Prime V3 prompt has no runnable example");
            // Execute the actual composed prompt, not a separately maintained recipe.
            python = PYTHON.slice(0, PYTHON.indexOf("from relayer_graph import"))
              + "async def main():\n" + example.split("\n").map((line) => "    " + line).join("\n")
              + "\nasyncio.run(main())\n";
          }
          if (nativeKernel) {
            const kernel = new nativeKernel.KernelManager({
              python: globalThis.process.env.RELAYER_TEST_PRIME_PYTHON,
              cwd: context.workspaceRoot ?? globalThis.process.cwd(),
              hostHandlers: hostRequestHandlers,
              requireHostRequestContext: true,
              processLauncher: ({ command, args, cwd, env }) => spawn(command, args, { cwd, env }),
            });
            try {
              await kernel.start();
              const shimEnd = python.indexOf("\n", python.indexOf("sys.modules['rlm'] =")) + 1;
              const code = `import sys, asyncio\nsys.path.insert(0, ${JSON.stringify(resolve("python/relayer-graph/src"))})\n` + python.slice(shimEnd);
              const result = await kernel.execute(code.replace("asyncio.run(main())", "await main()"), {
                hostRequestContext: { executionId: "visual-native-proof", runContext, signal: new AbortController().signal },
              });
              if (result.status !== "ok") throw new Error(JSON.stringify(result.error));
            } finally { await kernel.shutdown(); }
            persistPrompt(prompt);
            return;
          }
          const controller = new AbortController();
          let current = true;
          const server = createServer(async (request, response) => {
            const requestController = new AbortController();
            try {
              const chunks = []; for await (const chunk of request) chunks.push(chunk);
              const { method, payload } = JSON.parse(Buffer.concat(chunks));
              const value = await hostRequestHandlers[method]({ ...payload, type: method, cellSourceCode: "# Prime kernel execution metadata" }, { runContext, signal: requestController.signal, isCurrent: () => current && !controller.signal.aborted });
              response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
            } catch (error) {
              response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
            } finally {
              requestController.abort("host request settled");
            }
          });
          await new Promise((done) => server.listen(0, "127.0.0.1", done));
          try {
            await new Promise((done, reject) => {
              process = spawn("python3", ["-c", python], { env: { ...globalThis.process.env,
                PYTHONPATH: resolve("python/relayer-graph/src"),
                PRIME_FIXTURE_BRIDGE: `http://127.0.0.1:${server.address().port}`,
              } });
              let error = "";
              process.stderr.on("data", (bytes) => { error += bytes; });
              process.on("error", reject);
              process.on("exit", (code) => { if (code !== 0) console.error(error); code === 0 ? done() : reject(new Error(error || `Python exited ${code}`)); });
            });
          } finally {
            current = false; controller.abort();
            await new Promise((done) => server.close(done));
          }
          persistPrompt(prompt);
        },
        async waitForRlmQuiescence() {},
        async abort() { process?.kill(); },
        dispose() { process?.kill(); },
        async disposeAsync() { process?.kill(); },
      } };
    },
  }); } }).catch((error) => { console.error("Prime factory:", error); throw error; });
}

// Exercises exact published recipes through Prime's scoped bridge; the fixture
// supplies task content and supplemental relationship/navigation checks.
const PINNED_STRUCTURE = String.raw`
import ast, inspect, re, textwrap
from relayer_graph import GraphSession, GraphLayer, html, action_capability
graph = await GraphSession.current()
manifest = await graph.get_instruction_graph()
assert manifest == expected_manifest
assert manifest["retrievalContractVersion"] == 2
by_key = {entry["key"]: entry for entry in manifest["modules"]}
by_id = {entry["nodeId"]: entry for entry in manifest["modules"]}
selected = {}
def select(entry):
    for prerequisite in entry["prerequisites"]:
        select(by_id[prerequisite])
    selected[entry["nodeId"]] = entry
for key in ("input-contract", "publish-current", "finish-current", "detail-basic", "detail-theme", "detail-controls", "layout", "navigation", "attached-navigation"):
    select(by_key[key])
bodies = {}
ids = list(selected)
for offset in range(0, len(ids), 2):
    receipt = await graph.retrieve_instructions(request_key=f"visual-proof-{offset}", node_ids=ids[offset:offset+2], reason={"purpose":"verification", "detail":"Execute pinned Python visual publication recipes"})
    assert receipt["digest"] == manifest["digest"] and receipt["versionKey"] == manifest["versionKey"]
    assert not receipt["replayed"]
    for entry in receipt["entries"]:
        assert entry["delivery"] == "body"
        assert len(entry["detail"]) == entry["bodyCharacters"]
        assert len(entry["detail"].encode()) == entry["bodyBytes"]
        bodies[entry["key"]] = entry["detail"]
assert set(bodies) == {entry["key"] for entry in selected.values()}
scope = {"INTERACTION_NODE_ID": graph.node_id}
def recipe(key):
    cells = re.findall(r"\x60\x60\x60python\n(.*?)\n\x60\x60\x60", bodies[key], re.S)
    assert len(cells) == 1, key
    return cells[0]
async def execute(code):
    result = eval(compile(code, "<pinned-instruction>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), scope)
    if inspect.isawaitable(result):
        await result
def replace_once(code, old, new):
    assert code.count(old) == 1, old
    return code.replace(old, new, 1)

# Exercise the published early-Current recipe, adding the fixture's existing
# second-level evidence before that actual recipe writes and advances it.
code = recipe("publish-current")
code = replace_once(code, 'title="Observed finding"', 'title="Initial finding"')
code = replace_once(code, "Replace with the actual finding.", "Replace with supported evidence and uncertainty.")
insertion = '''
from relayer_graph import action_capability
evidence_layer = author.layer("early-evidence")
evidence = evidence_layer.node("evidence", icon="info", title="Evidence", detail="Supporting detail")
evidence.detail_authoring.set_component("main", html("<p>Replace with useful supporting detail.</p>"))
evidence_layer.layout([(evidence, 0.5, 0.5)], edge_shape="default", default_node=evidence)
early_expand = layer.action("evidence", answer, kind="navigate", relation="expand", label="Evidence", target=evidence_layer)
answer.detail_authoring.set_component("evidence", html(["<button gc=", ">Evidence</button>"], action_capability("early-evidence", early_expand)))
'''
code = replace_once(code, "layer.layout([(answer, 0.5, 0.5)]", textwrap.dedent(insertion) + "\nlayer.layout([(answer, 0.5, 0.5)]")
await execute(code)
first_current = await graph.get_current()
assert first_current["currentLayerId"] == scope["written"].root_layer.id
assert any(action["label"] == "Evidence" for action in (await graph.get_layer(first_current["currentLayerId"]))["actions"]), "Initial Current lost its Evidence action"

# Keep the previous graph/depth assertions while exercising the retrieved
# detail and action-binding recipes on the final three-node response.
author = graph.authoring("visual-final")
layer = author.layer("overview")
result = layer.node("result", icon="info", title="Result", detail="Visual acceptance result")
reasoning = layer.node("reasoning", icon="info", title="Why this follows", detail="The real Python client authored this graph.")
verification = layer.node("verification", icon="info", title="Evidence and limits", detail="Deterministic fixture evidence; no model inference.")
layer.edge("reasoning", result, reasoning)
layer.edge("verification", result, verification)
evidence_layer = author.layer("support")
support = evidence_layer.node("support", icon="info", title="Supporting evidence", detail="Replace with actual check output, source extract or worked example.")
for answer in (result, reasoning, verification, support):
    scope["answer"] = answer
    code = replace_once(recipe("detail-basic"), "Explain this node's actual result.", answer.detail)
    code = replace_once(code, "<h2>Result</h2>", "<h2>" + answer.title + "</h2>")
    await execute(code)
scope.update(layer=layer, answer=verification, evidence_layer=evidence_layer)
await execute(recipe("detail-controls").replace("Inspect evidence", "Inspect supporting evidence"))
prior = await graph.get_layer(first_current["currentLayerId"])
earlier = layer.action("earlier", result, kind="navigate", relation="reference", label="Earlier findings", target=GraphLayer.from_dict(prior["layer"]))
result.detail_authoring.set_component("earlier", html(["<button gc=", ">Earlier findings</button>"], action_capability("earlier", earlier)))
evidence_layer.layout([(support, 0.5, 0.5)], edge_shape="default", default_node=support)
layer.layout([(result, 0.2, 0.5), (reasoning, 0.8, 0.25), (verification, 0.8, 0.75)], edge_shape="default", default_node=result)
written = await author.write(layer)
await graph.add_navigate_action(graph.node_id, "Task findings", written.root_layer, relation="expand", icon="info", client_key="root-response")
await graph.advance_current(written.root_layer, expected_revision=first_current["headRevision"], operation_key="final-visual")
assert any(action["label"] == "Evidence" for action in (await graph.get_layer(first_current["currentLayerId"]))["actions"]), "Later Current lost prior Evidence action"
await execute(recipe("finish-current"))
`;

const PYTHON = String.raw`
import asyncio, json, os, sys, types
from urllib.request import Request, urlopen
async def host_request(method, payload=None):
    def send():
        with urlopen(Request(os.environ['PRIME_FIXTURE_BRIDGE'], data=json.dumps({'method': method, 'payload': payload}).encode(), headers={'content-type': 'application/json'})) as response:
            return json.load(response)
    return await asyncio.to_thread(send)
sys.modules['rlm'] = types.SimpleNamespace(host_request=host_request)
from relayer_graph import GraphSession, NodeObject, LayerObject, LayerLayoutObject, NodePlacementObject, ActionObject, html, action_capability, external_link, asset_ref, VisualAssetFile
async def main():
    graph = await GraphSession.current()
    scope = await graph.visual_assets.scope()
    image = await graph.visual_assets.add(file=VisualAssetFile('proof.svg', 'image/svg+xml', b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#2563eb"/></svg>'), scope=scope, name='Prime proof')
    inspected = await graph.visual_assets.inspect(image['id'], scope)
    assert inspected['preview'].read()
    assert (await graph.visual_assets.download(image['id'], scope)).read()
    assert (await graph.visual_assets.list_assets(scope=scope))['items']
    draft = NodeObject('box', 'Prime visual answer', 'Prime compatibility fallback', client_key='answer')
    from relayer_graph.exceptions import ValidationError
    draft.detail_authoring.set_component('draft', html('<script>invalid</script>'))
    try:
        await graph.checkpoint_node_detail(draft)
    except ValidationError as error:
        assert error.status == 422
        assert error.details['issues']
        assert error.details['issues'][0]['componentId'] == 'draft'
        assert 'draft' in str(error)
    else:
        raise AssertionError('invalid authored markup was accepted')
    draft.detail_authoring.set_component('draft', html('<p>Draft checkpoint</p>'))
    await graph.submit_node(draft)
    retained = NodeObject('box', 'Prime visual answer', 'Prime compatibility fallback', client_key='answer')
    await graph.submit_node(retained)
    assert retained.ref.authored_detail == draft.ref.authored_detail
    cleared = NodeObject('box', 'Prime visual answer', 'Prime compatibility fallback', client_key='answer')
    cleared.detail_authoring.clear()
    await graph.submit_node(cleared)
    assert cleared.ref.authored_detail is None
    node = NodeObject('box', 'Prime visual answer', 'Prime compatibility fallback', client_key='answer')
    root = LayerObject([node], [], LayerLayoutObject([NodePlacementObject(node, .5, .5)], 'default'), client_key='root')
    notes = NodeObject('box', 'Implementation notes', 'Notes fallback', client_key='notes')
    notes.detail_authoring.set_component('main', html('<p>Implementation notes</p>'))
    evidence = NodeObject('box', 'Supporting evidence', 'Evidence fallback', client_key='evidence')
    evidence.detail_authoring.set_component('main', html('<p>Supporting evidence</p>'))
    notes_layer = LayerObject([notes], [], LayerLayoutObject([NodePlacementObject(notes, .5, .5)], 'default'), client_key='notes-layer')
    evidence_layer = LayerObject([evidence], [], LayerLayoutObject([NodePlacementObject(evidence, .5, .5)], 'default'), client_key='evidence-layer')
    expand = ActionObject('navigate', 'Implementation notes', root, 'expand', relation='expand', target=notes_layer)
    reference = ActionObject('navigate', 'Supporting evidence', root, 'reference', relation='reference', target=evidence_layer)
    invoke = ActionObject('invoke', 'Continue', root, 'continue', interaction_text='Continue this answer')
    text = ActionObject('input', 'Your choice', root, 'choice', control='text', prompt='Your choice')
    node.detail_authoring.set_component('main', html([
        '<h2>Prime visual answer</h2><img asset=', ' alt="Prime proof"><a gc=', '>Source</a><button gc=', '>Continue</button><label for="choice">Your choice</label><input id="choice" gc=', '><button gc=', '>Implementation notes</button><button gc=', '>Supporting evidence</button>'
    ], asset_ref(image['id']), external_link('source', 'https://example.com'), action_capability('continue', invoke), action_capability('choice', text), action_capability('expand', expand), action_capability('reference', reference)), 'h2 { color: blue; }')
    checkpoint = await graph.checkpoint_node_detail(node)
    assert len(checkpoint['assets']) == 1
    await graph.submit_node(node)
    assert node.ref.authored_detail == checkpoint
    assert await graph.checkpoint_node_detail(node) == checkpoint
    await graph.submit_node(notes)
    await graph.submit_node(evidence)
    await graph.submit_layer(notes_layer)
    await graph.submit_layer(evidence_layer)
    await graph.submit_layer(root)
    await graph.add_action(node, expand)
    await graph.add_action(node, reference)
    await graph.add_action(node, invoke)
    await graph.add_action(node, text)
    await graph.add_navigate_action(graph.node_id, 'Answer', root, relation='expand', client_key='response')
    await graph.submit()
    # Terminal graph authority must reject a fresh asset query.
    try:
        await graph.visual_assets.scope()
    except Exception:
        pass
    else:
        raise AssertionError('terminal asset authority survived')
asyncio.run(main())
`;
