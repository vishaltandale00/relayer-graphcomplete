const { RelayerGraphClient, NodeObject, html, css } = await import(process.env.RELAYER_LIVE_PROBE_CLIENT_MODULE_URL);
const graph = RelayerGraphClient.fromEnv(); const failures = [];
async function caught(label, fn) { try { await fn(); failures.push({label, unexpectedSuccess:true}); } catch (e) { failures.push({label, name:e.name, codes:e.issues?.map(i=>i.code) ?? []}); } }
await caught('client-missing-edge-arguments', () => graph.createEdge());
await caught('compiler-nested-template', () => html`<section>${html`<p>probe</p>`}</section>`);
const broken = new NodeObject('info', 'Capture probe', 'Discarded compiler-only probe', 'concept', 'capture-probe');
broken.detailAuthoring.setComponent('main', html`<p>probe</p>`, css`p { cursor: pointer; }`);
await caught('compiler-checkpoint-1', () => graph.checkpointNodeDetail(broken));
await caught('compiler-checkpoint-2', () => graph.checkpointNodeDetail(broken));
const headers = {authorization:'Bearer '+process.env.RELAYER_GRAPH_TOKEN, 'content-type':'application/json'};
const rejected = await fetch(process.env.RELAYER_GRAPH_URL+'/api/graph/nodes', {method:'POST', headers, body:'{}'});
failures.push({label:'server-invalid-node', status:rejected.status}); await rejected.text();
const read = await fetch(process.env.RELAYER_GRAPH_URL+'/api/graph/nodes/999999999', {headers}); await read.text();
await new Promise(r=>setTimeout(r,200));
console.log('AUTHORING_ERROR_PROBE '+JSON.stringify({diagnosticsEnabled:process.env.RELAYER_GRAPH_AUTHORING_ERRORS==='1', failures, excludedReadStatus:read.status}));