/** Mechanics examples, shared with executable contract tests. Never a response template. */
export const JS_DETAIL_EXAMPLE = `const node = new NodeObject("info", "Comparison", "Two alternatives.", "concept", "comparison");
const sharedStyles = css\`section { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }\`;
node.detailAuthoring.setComponent("main", html\`<section><p>First alternative</p><p>Second alternative</p></section>\`, sharedStyles);`;

export const PYTHON_DETAIL_EXAMPLE = `from relayer_graph import NodeObject, html
node = NodeObject("info", "Comparison", "Two alternatives.", client_key="comparison")
shared_styles = "section { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }"
node.detail_authoring.set_component("main", html("<section><p>First alternative</p><p>Second alternative</p></section>"), shared_styles)`;

export const JS_QUESTION_EXAMPLE = `const question = { kind: "input", label: "Answer", control: "text", prompt: "Which constraint matters most?", sourceLayer: layer, clientKey: "constraint-question" };
node.detailAuthoring.setComponent("question", html\`<label>Constraint <textarea aria-label="Constraint" gc=\${detailCapability.input("constraint", question)}></textarea></label>\`);`;

export const PYTHON_QUESTION_EXAMPLE = `from relayer_graph import ActionObject, action_capability
question = ActionObject("input", "Answer", layer, "constraint-question", control="text", prompt="Which constraint matters most?")
node.detail_authoring.set_component("question", html(['<label>Constraint <textarea aria-label="Constraint" gc=', '></textarea></label>'], action_capability("constraint", question)))`;

export const JS_NAVIGATION_EXAMPLE = `const navigation = { kind: "navigate", relation: "expand", label: "Open evidence", sourceLayer: layer, target: targetLayer, clientKey: "open-evidence" };
node.detailAuthoring.setComponent("navigation", html\`<button gc=\${detailCapability.expand("evidence", navigation)}>Open evidence</button>\`);`;

export const PYTHON_NAVIGATION_EXAMPLE = `from relayer_graph import ActionObject, action_capability
navigation = ActionObject("navigate", "Open evidence", layer, "open-evidence", target=target_layer, relation="expand")
node.detail_authoring.set_component("navigation", html(['<button gc=', '>Open evidence</button>'], action_capability("evidence", navigation)))`;

const INCREMENTAL_AUTHORING = "Build and validate in small increments: checkpoint one small component before expanding the authoring program. On failure, repair the reported component/path and keep validated content and stable client keys unchanged; do not redesign or regenerate unrelated pages. Reuse CSS and functions that construct fresh node-specific markup, not previously owned HTML templates. This is authoring and repair guidance, not a required query flow or publication schedule. A checkpoint does not publish a graph. When useful work is ready, you may publish a small valid closure before authoring the rest, respecting accepted-record immutability and the prior-current navigation contract.";

const QUESTION_LIFECYCLE = "Question lifecycle: an input control collects an answer for the next user Send, which creates a new interaction. Its presenting response must be finalized before the answer can be committed. Re-reading this interaction's input returns its fixed snapshot; it does not await future answers. Input controls grant no additional write authority.";

export const JS_AUTHORING_REFERENCE = `JavaScript capability reference for this execution:
Read input: const input = await graph.getInteractionInput(). The user text is input.interaction.detail; contexts have targetNode and annotations. Answers are input.submittedInputs ?? []; each has action (control, prompt, and optional options) and value ({ text } or { selected: [{ key, label }] }). There is no top-level input.message.
Draft writes: await graph.submitNode(node); await graph.createEdge(edge); await graph.submitLayer(layer); await graph.addAction(node, action). Constructors: new NodeObject(icon, title, detail, kind, clientKey), new EdgeObject([left, right], clientKey), new LayerObject(nodes, edges, layout, clientKey), new LayerLayoutObject(placements), new NodePlacementObject(node, x, y).
${QUESTION_LIFECYCLE}

Independent mechanics examples, not a recommended response design or required workflow. Import these exports from the graph-client module supplied for this execution. Choose your own content, topology, and publication timing.
Visual component (no publication):
\`\`\`javascript
${JS_DETAIL_EXAMPLE}
await graph.checkpointNodeDetail(node);
\`\`\`
${INCREMENTAL_AUTHORING} Checkpoint validates and stages detail; it does not accept a response or advance current. Repair the reported component/path before retrying. CSS is the constrained compiler vocabulary below, not browser CSS: border-collapse and cursor are unsupported. Use grid for this comparison. HTML interpolation slots accept typed gc/asset bindings only, not ordinary text or nested HTML strings.
Control bindings require a stable binding key as the first argument and the exact action object as the second: detailCapability.expand(key, action) for navigate/expand, detailCapability.reference(key, action) for navigate/reference, detailCapability.invoke(key, action) for invoke, and detailCapability.input(key, action) for input. For a URL use detailCapability.externalLink(key, href). There is no detailCapability.navigate or detailCapability.text. The binding key identifies a control in the component; it does not replace the action's clientKey. Write prose in literal HTML, not interpolation slots.
Navigation control (node belongs to layer; targetLayer is the destination layer):
\`\`\`javascript
${JS_NAVIGATION_EXAMPLE}
\`\`\`
Checkpoint after binding; submit the nodes and both layers before registering the same navigation with await graph.addAction(node, navigation).
Question control (node is a draft member of layer):
\`\`\`javascript
${JS_QUESTION_EXAMPLE}
\`\`\`
Checkpoint after binding, submit nodes and layer, then register that same question with await graph.addAction(node, question). A control alone is not a response root.
Publication operation, after the complete closure and all actions exist: const current = await graph.getCurrent(); const receipt = await graph.advanceCurrent(layer, current.headRevision, operationKey). Keep the exact transition tuple for retries. This is independent of terminal await graph.submit(interactionNodeId). Choose when to use either; a successful terminal submission ends graph access.`;

export const PYTHON_AUTHORING_REFERENCE = `Python capability reference for this execution:
Read input: interaction = await graph.get_interaction_input(). The user text is interaction.interaction.detail; contexts have target_node and annotations. Answers are interaction.submitted_inputs; each has action (a mapping with control, prompt, and optional options) and value (a mapping with text or selected key/label records). There is no top-level interaction.message.
${QUESTION_LIFECYCLE}

Independent mechanics examples, not a recommended response design or required workflow. Choose your own content, topology, and publication timing. Use the public client API; inspect a specific signature or error when needed.
Visual component (no publication):
\`\`\`python
${PYTHON_DETAIL_EXAMPLE}
await graph.checkpoint_node_detail(node)
\`\`\`
${INCREMENTAL_AUTHORING} Checkpoint validates and stages detail; it does not accept a response or advance current. Repair the reported component/path before retrying. CSS is the constrained compiler vocabulary below, not browser CSS: border-collapse and cursor are unsupported. Use grid for this comparison. html bindings accept typed action/asset bindings only, not ordinary text or nested HTML strings.
Control bindings use action_capability(key, action) for navigate/expand, navigate/reference, invoke, and input actions; the action supplies its kind and relation. For a URL use external_link(key, href), imported from relayer_graph. Always pass a stable binding key first and the exact action object second. The binding key does not replace the action's client_key. Write prose in literal HTML, not bindings.
Navigation control (node belongs to layer; target_layer is the destination layer):
\`\`\`python
${PYTHON_NAVIGATION_EXAMPLE}
\`\`\`
Checkpoint after binding; submit the nodes and both layers before registering the same navigation with await graph.add_action(node, navigation).
Question control (node is a draft member of layer):
\`\`\`python
${PYTHON_QUESTION_EXAMPLE}
\`\`\`
Checkpoint after binding, submit nodes and layer, then register that same question with await graph.add_action(node, question). A control alone is not a response root.
Publication operation, after the complete closure and all actions exist: current = await graph.get_current(); receipt = await graph.advance_current(layer, expected_revision=current["headRevision"], operation_key=operation_key). Keep the exact transition tuple for retries. This is independent of terminal await graph.submit(interaction_node_id). Choose when to use either; a successful terminal submission ends graph access.`;
