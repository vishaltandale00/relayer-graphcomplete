import { afterEach, expect, it, vi } from "vitest";
import { RelayerGraphClient } from "../src/client.js";
import { GRAPH_QUERY_CONTRACT_VERSION } from "../src/query-errors.generated.js";

afterEach(() => vi.unstubAllGlobals());

it("retrieves instruction metadata, selected bodies, layers, and bounded queries using the task capability", async () => {
  const calls: { url: string; authorization: string | null; body: unknown }[] = [];
  const manifest = { versionKey: "v1", digest: "d".repeat(64), threadId: 8000000000000000, interactionNodeId: 100, rootLayerId: 101, modules: [{ key: "authoring", title: "Authoring", nodeId: 102, prerequisites: [] }] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, authorization: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : null });
    const body = url.endsWith("/search") ? { queryContractVersion: GRAPH_QUERY_CONTRACT_VERSION, columns: [], rows: [], truncated: false } : url.endsWith("/nodes/102") ? { node: { id: 102, detail: "Selected instruction" } } : manifest;
    return new Response(JSON.stringify(body));
  }));
  const graph = new RelayerGraphClient({ url: "http://graph.test", token: "task", nodeId: 9 });
  expect(await graph.getInstructionGraph()).toEqual(manifest);
  expect(await graph.getInstructionNode(102)).toMatchObject({ id: 102, detail: "Selected instruction" });
  await graph.getInstructionLayer(101);
  await graph.searchInstructions({ queryContractVersion: GRAPH_QUERY_CONTRACT_VERSION, query: "MATCH (n:Content) RETURN n.id AS id LIMIT 4", parameters: {} });
  expect(calls.map(call => call.url)).toEqual([
    "http://graph.test/api/graph/instruction-graph",
    "http://graph.test/api/graph/instruction-graph/nodes/102",
    "http://graph.test/api/graph/instruction-graph/layers/101",
    "http://graph.test/api/graph/instruction-graph/search",
  ]);
  expect(calls.every(call => call.authorization === "Bearer task")).toBe(true);
  expect(calls[3]?.body).toMatchObject({ queryContractVersion: GRAPH_QUERY_CONTRACT_VERSION, budget: {} });
});

it("sends operational reasons and consumes reasoned v2 body and suppression receipts",async()=>{
  const reason={purpose:"authoring",detail:"Publish the requested response"} as const;
  const request={requestKey:"start",nodeIds:[102],reason};
  const calls:unknown[]=[];
  const receipt={versionKey:"v2",digest:"d".repeat(64),requestKey:"start",replayed:false,reason,
    entries:[{nodeId:102,key:"publish",title:"Publish",delivery:"body",detail:"Recipe",bodyCharacters:6,bodyBytes:6}]};
  vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(url.endsWith("/retrieve")?receipt:{queryContractVersion:1,columns:[],rows:[],truncated:false,instructionSearchReceipt:{reason}}));
  }));
  const graph=new RelayerGraphClient({url:"http://graph.test",token:"task",nodeId:9});
  expect(await graph.retrieveInstructions(request)).toEqual(receipt);
  await graph.searchInstructions({queryContractVersion:1,query:"MATCH (n:Content) RETURN n.title AS title",reason});
  expect(calls[0]).toEqual(request);expect(calls[1]).toMatchObject({reason});
});
