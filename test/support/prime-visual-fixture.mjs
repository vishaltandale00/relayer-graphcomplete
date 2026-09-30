import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { PrimeAgentHarness } from "../../packages/harness-host/dist/implementations/prime-agent.js";

// Replaces inference only. The real factory, run context, Python client, compiler,
// authenticated graph/asset routes and Rust acceptance remain in the path.
export function primeVisualFixtureFactory(context) {
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
      open: (sessionFile) => {
        const history = JSON.parse(readFileSync(sessionFile, "utf8"));
        assert.equal(history.schemaVersion, 1);
        assert.equal(history.threadId, context.threadId);
        assert.ok(Array.isArray(history.prompts) && history.prompts.length > 0, "Reopened native fixture history must contain the prior completed prompt");
        assert.ok(history.prompts.every(prompt => typeof prompt === "string" && prompt.includes("Current interaction node:")), "Reopened history must contain actual Prime harness prompts");
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
            const examples = [...prompt.matchAll(/```python\n([\s\S]*?)\n```/g)].map(match => match[1]);
            const visual = examples.find(code => code.includes('shared_styles'));
            const question = examples.find(code => code.includes('question = ActionObject'));
            if (!visual || !question) throw new Error("Prime prompt has no visual/question examples");
            // Execute the delivered independent examples with explicit fixture-owned
            // context/publication. Prompt examples no longer dictate a whole response.
            const example = `from relayer_graph import GraphSession, NodeObject, LayerObject, LayerLayoutObject, NodePlacementObject, ActionObject, html, action_capability
graph = await GraphSession.current()
${visual}
layer = LayerObject([node], [], LayerLayoutObject([NodePlacementObject(node, 0.5, 0.5)]), client_key="answer-layer")
${question}
child = NodeObject("info", "Details", "Supporting evidence.", client_key="details")
child.detail_authoring.set_component("main", html("<p>Explain the evidence behind the answer.</p>"))
child_layer = LayerObject([child], [], LayerLayoutObject([NodePlacementObject(child, 0.5, 0.5)]), client_key="details-layer")
expand = ActionObject("navigate", "Details", layer, "details-action", relation="expand", target=child_layer)
node.detail_authoring.set_component("navigation", html(['<button gc=', '>Details</button>'], action_capability("details", expand)))
for item in [node, child]:
    await graph.checkpoint_node_detail(item)
    await graph.submit_node(item)
await graph.submit_layer(child_layer)
await graph.submit_layer(layer)
await graph.add_action(node, question)
await graph.add_action(node, expand)
await graph.add_navigate_action(graph.node_id, "Answer", layer, relation="expand", client_key="response")
current = await graph.get_current()
await graph.advance_current(layer, expected_revision=current["headRevision"], operation_key="fixture-answer-ready")
await graph.submit(graph.node_id)`;
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
        async reload() {},
        async waitForRlmQuiescence() {},
        async abort() { process?.kill(); },
        dispose() { process?.kill(); },
        async disposeAsync() { process?.kill(); },
      } };
    },
  }); } }).catch((error) => { console.error("Prime factory:", error); throw error; });
}

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
    root = LayerObject([node], [], LayerLayoutObject([NodePlacementObject(node, .5, .5)]), client_key='root')
    notes = NodeObject('box', 'Implementation notes', 'Notes fallback', client_key='notes')
    notes.detail_authoring.set_component('main', html('<p>Implementation notes</p>'))
    evidence = NodeObject('box', 'Supporting evidence', 'Evidence fallback', client_key='evidence')
    evidence.detail_authoring.set_component('main', html('<p>Supporting evidence</p>'))
    notes_layer = LayerObject([notes], [], LayerLayoutObject([NodePlacementObject(notes, .5, .5)]), client_key='notes-layer')
    evidence_layer = LayerObject([evidence], [], LayerLayoutObject([NodePlacementObject(evidence, .5, .5)]), client_key='evidence-layer')
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
