import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { startGraphOperationRecorder } from "../desktop/main/services/graph-operation-recorder.mjs";
import { authoringErrorsFromOperations } from "../desktop/eval-main/authoring-errors.mjs";
import * as diagnostics from "../packages/graph-client/src/authoring-errors.ts";
import { HarnessHost } from "../packages/harness-host/src/host.ts";

const cleanups = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "authoring-delivery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const interaction = {id:17,kind:"user-interaction",icon:"user",title:"Question",detail:"Question",state:"accepted"};
  const server = createServer((request, response) => {
    request.resume();
    const unavailable = request.url.endsWith("/personal-presentation") || request.url.endsWith("/output");
    response.writeHead(unavailable ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(unavailable ? {error:{code:request.url.endsWith("/output")?"completion_not_found":"personal_presentation_not_attached"}}
      : request.url.endsWith("/input") ? {interaction,contexts:[]} : {node:interaction,nodes:[]}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => server.close(resolve)));
  const recorder = await startGraphOperationRecorder({ upstreamUrl: `http://127.0.0.1:${server.address().port}`, ...options });
  cleanups.push(() => recorder.close());
  const capability = { url: recorder.url, token: "delivery-fixture-secret", nodeId: 17, authoringErrors: true, programDirectory: directory };
  await fetch(`${recorder.url}/api/control/capabilities`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: 17, graphToken: capability.token }) });
  return { directory, recorder, capability };
}
async function child(capability, trigger, caught = false) {
  const module = pathToFileURL(resolve("packages/graph-client/dist/index.js")).href;
  const setup = `import {RelayerGraphClient, html} from ${JSON.stringify(module)}; const graph=RelayerGraphClient.fromEnv();const layer=graph.authoring("fixture").layer("answer");`;
  const source = setup + (caught ? `try { ${trigger} } catch(error) { console.error(error.name); await new Promise(resolve => setTimeout(resolve,100)); }` : trigger);
  const process = spawn(globalThis.process.execPath, ["--input-type=module"], { env: { ...globalThis.process.env, RELAYER_GRAPH_URL: capability.url, RELAYER_GRAPH_TOKEN: capability.token, RELAYER_NODE_ID: "17", RELAYER_GRAPH_AUTHORING_ERRORS: "1", RELAYER_GRAPH_PROGRAM_DIR: capability.programDirectory }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; process.stderr.on("data", bytes => { stderr += bytes; }); process.stdout.resume(); process.stdin.end(source);
  const code = await new Promise((resolve, reject) => { process.once("error", reject); process.once("close", resolve); });
  return { code, stderr };
}
async function records(f) {
  const target = join(f.directory, "trace"); await mkdir(target);
  await writeFile(join(target, "manifest.json"), JSON.stringify({ schemaVersion: 1, interactionNodeId: 17, artifacts: {} }));
  await f.recorder.exportInteraction(17, target);
  return (await readFile(join(target, "graph-operations.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}
const node = `layer.node("finding", {icon:"info",title:"Answer",detail:"Detail",clientKey:"private-authored-field"});`;
const action = `const node=layer.node("finding",{icon:"info",title:"Answer",detail:"Detail"});layer.action("details",node,{kind:"invoke",label:"Details",interactionText:"Details",sourceLayer:layer.object,clientKey:"private-authored-field"});`;
const compiler = `html(["<p>","</p>"],html("<p>private-authored-text</p>"));`;
it.each([["node",node],["action",action],["compiler",compiler]])("captures uncaught %s origin after immediate child exit without replacing the error", async (_name, trigger) => {
  const f = await fixture();
  const result = await child(f.capability, trigger);
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/GraphAuthoringValidationError|TypeError/);
  const files = (await readdir(f.directory)).filter(name => name.startsWith("authoring-error-"));
  expect(files.length).toBe(1);
  const bytes = await readFile(join(f.directory,files[0]), "utf8");
  expect(bytes).not.toMatch(/private-authored|delivery-fixture-secret|stack|sourceLayer/);
  await diagnostics.flushAuthoringErrors(f.capability);
  const events = await records(f);
  expect(authoringErrorsFromOperations(events)).toMatchObject({ observed: 1, total: null, coverage: "partial", byCause: { [_name === "compiler" ? "compiler" : "client"]: 1 } });
});
it("deduplicates normal caught delivery and spool replay before spending diagnostic budget", async () => {
  const f = await fixture();
  expect((await child(f.capability,node,true)).code).toBe(0);
  await diagnostics.flushAuthoringErrors(f.capability);
  const events = await records(f);
  expect(events.filter(event => event.authoringError)).toHaveLength(1);
  expect(authoringErrorsFromOperations(events).observed).toBe(1);
});
it("ignores malformed, oversized and symlinked spool files without reading private content", async () => {
  const f = await fixture();
  await writeFile(join(f.directory,"authoring-error-0.json"), JSON.stringify({ schemaVersion:1,id:"x",phase:"client",codes:["private-code"] }));
  await writeFile(join(f.directory,"authoring-error-1.json"), "x".repeat(2048));
  await writeFile(join(f.directory,"private.txt"), "private-content");
  await symlink(join(f.directory,"private.txt"),join(f.directory,"authoring-error-2.json"));
  await diagnostics.flushAuthoringErrors(f.capability);
  expect(authoringErrorsFromOperations(await records(f)).observed).toBe(0);
});

it("deduplicates spool-first replay and subsequent HTTP delivery without exhausting the origin budget", async () => {
  const f = await fixture({ maxAuthoringDiagnosticsPerInteraction: 1 });
  const body = { schemaVersion: 1, id: "00000000-0000-0000-0000-000000000001", phase: "client", codes: ["client_validation"] };
  await writeFile(join(f.directory,"authoring-error-0.json"),JSON.stringify(body));
  await diagnostics.flushAuthoringErrors(f.capability);
  for (let attempt=0; attempt<3; attempt++) {
    const response = await fetch(`${f.recorder.url}/api/graph/authoring-errors`, { method:"POST", headers:{authorization:`Bearer ${f.capability.token}`,"content-type":"application/json"}, body:JSON.stringify(body) });
    expect(response.status).toBe(202);
  }
  const events = await records(f);
  expect(events).toHaveLength(1);
  const manifest = JSON.parse(await readFile(join(f.directory,"trace","manifest.json"),"utf8"));
  expect(manifest.artifacts.graphOperations.authoringDiagnosticsDiscarded).toBeUndefined();
});
it("bounds unavailable delivery across the whole drain and preserves partial metrics", async () => {
  const f = await fixture();
  for(let slot=0; slot<3; slot++) await writeFile(join(f.directory,`authoring-error-${slot}.json`), JSON.stringify({schemaVersion:1,id:`00000000-0000-0000-0000-${String(slot).padStart(12,"0")}`,phase:"client",codes:["client_validation"]}));
  let requests=0;
  vi.stubGlobal("fetch", (_url, init) => { requests++; return new Promise((_resolve,reject) => init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true})); });
  const started=performance.now();
  await diagnostics.flushAuthoringErrors(f.capability);
  expect(performance.now()-started).toBeLessThan(2000);
  expect(requests).toBe(1);
  vi.unstubAllGlobals();
  expect(authoringErrorsFromOperations(await records(f))).toMatchObject({observed:0,total:null,coverage:"partial"});
});
it("bounds spool saturation, preserves opt-out, and never recreates removed turn directories", async () => {
  const directory = await mkdtemp(join(tmpdir(),"authoring-spool-bound-"));
  cleanups.push(() => rm(directory,{recursive:true,force:true}));
  const capability={url:"http://127.0.0.1:1",token:"fixture",nodeId:17,authoringErrors:true,programDirectory:directory};
  vi.stubGlobal("fetch",vi.fn(async()=>new Response("{}",{status:202})));
  diagnostics.reportAuthoringError({...capability,authoringErrors:false},new Error("disabled"));
  expect(await readdir(directory)).toHaveLength(0);
  for(let attempt=0;attempt<257;attempt++) diagnostics.reportAuthoringError(capability,new Error("private-text"));
  const files=await readdir(directory);
  expect(files).toHaveLength(256);
  expect((await Promise.all(files.map(file=>readFile(join(directory,file))))).every(bytes=>bytes.length<=1024)).toBe(true);
  await rm(directory,{recursive:true});
  expect(()=>diagnostics.reportAuthoringError(capability,new Error("removed"))).not.toThrow();
  await expect(readdir(directory)).rejects.toMatchObject({code:"ENOENT"});
});

it("captures a native child failure through real host cleanup before capability revocation and ledger export", async () => {
  const f=await fixture();
  let result;
  const host=new HarnessHost({stateFile:join(f.directory,"sessions.json"),controlToken:"control",implementations:{test:()=>({
    async complete(context) {
      result=await child(context.graph.acquireCapability(),node);
      throw new Error(`native authoring exited ${result.code}`);
    },state:()=>({}),
  })}});
  cleanups.push(()=>host.close());
  await host.initialize();
  await host.createSession({threadId:1,permissionProfileId:"auto",workingDirectory:f.directory,configuration:{schemaVersion:1,name:"delivery-fixture",implementation:"test",implementationVersion:1,permissionBindings:{ask:{},auto:{},full:{}},settings:{}}});
  await expect(host.complete(1,17,f.capability,undefined,undefined,{productInteractionId:17})).rejects.toThrow("native authoring exited 1");
  expect(result.stderr).toContain('Unknown node field "clientKey"');
  await fetch(`${f.recorder.url}/api/control/capabilities`,{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({graphToken:f.capability.token})});
  expect(authoringErrorsFromOperations(await records(f))).toMatchObject({observed:1,total:null,coverage:"partial",byCause:{client:1}});
});
