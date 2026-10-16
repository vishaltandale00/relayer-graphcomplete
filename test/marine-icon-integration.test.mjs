import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { marineEcologyFixtureFactory } from "../scripts/fixtures/marine-ecology-icons.mjs";

it("parses the bounded desktop marine evidence entry point on every platform", () => {
  const result = spawnSync(process.execPath, ["--check", resolve("scripts/evidence-marine-icons.mjs")], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

it("authors the sourced marine ecology fixture through production catalog discovery, inspection and acceptance", async () => {
  const root=resolve(".");
  const directory=await mkdtemp(join(tmpdir(),"marine-icon-proof-"));
  const config=join(directory,"marine.yaml");
  await writeFile(config,(await readFile(join(root,"harnesses/fixture-task-system.yaml"),"utf8")).replace("providerId: codex","providerId: openai-work").replace("managed-runtime@1","secret@1"));
  const runtime=new GraphCompleteRuntimeService({userDataDirectory:directory,
    graphServerBinary:join(root,"target/debug/relayer-graph-server"),configurationPaths:[config],
    additionalImplementations:{"fixture.task-system":marineEcologyFixtureFactory},
    acquireProviderExecution:async(providerId)=>({definition:{id:providerId,adapterId:"openai-api",accessContract:"secret@1",endpoint:"https://unused.invalid/v1"},descriptor:{adapterId:"openai-api",accessContract:"secret@1",implementationVersion:"2"},runtime:{async executionAccess(){return {kind:"secret",contract:"secret@1",providerId,adapterId:"openai-api",adapterImplementationVersion:"2",endpoint:"https://unused.invalid/v1",fields:{"api-key":"deterministic-unused"}};}},async release(){}}),
  });
  let product;
  try {
    product=new RelayerAppServerService({userDataDirectory:directory,binaryPath:join(root,"target/debug/relayer-app-server"),webDirectory:join(root,"desktop/renderer"),permissionCatalogPath:join(root,"permissions/desktop.json"),runtimeSession:await runtime.start(),defaultHarnessConfiguration:"fixture-task-system",allowHarnessOverride:true,enableReadOnlySession:true,exportProducer:{desktopVersion:"fixture",buildCommit:"0".repeat(40),platform:"darwin",architecture:"arm64"}});
    const session=await product.start();
    await product.providerDefinitionStore().save([{id:"openai-work",adapterId:"openai-api",label:"Fixture",endpoint:"https://unused.invalid/v1",accessContract:"secret@1",credentialReference:"fixture",lifecycleState:"active",removedAt:null}]);
    await product.seedProviderCatalog({providerId:"openai-work",label:"Fixture",connected:true,models:[{id:"fixture-model",label:"Fixture",order:0,visible:true,available:true,providerDefault:true,metadata:{}}],systemFamily:{key:"fixture",name:"Fixture",modelIds:["fixture-model"]}});
    const family=await request(session,"/api/model-families",{method:"POST",body:JSON.stringify({name:"Fixture",enabled:true,members:[{providerId:"openai-work",modelId:"fixture-model", roles: [{ name: "orchestrator" }]}]})});
    const thread=await request(session,"/api/threads",{method:"POST",body:JSON.stringify({title:"Marine ecology",initialMessage:"Explain coral, jellyfish, octopus, sea turtles, plankton and reef monitoring.",permissionProfileId:"full",harnessId:"fixture-task-system",modelSelection:{familyId:family.id,providerId:"openai-work",modelId:"fixture-model"}})});
    let turn;
    for(let attempt=0;attempt<300;attempt++){
      turn=(await request(session,`/api/threads/${thread.id}`)).interactions[0];
      if(turn?.completionStatus==="accepted")break;
      if(turn?.completionStatus==="failed"||turn?.latestAttempt?.finishedAt)throw Error(JSON.stringify(turn));
      await new Promise(done=>setTimeout(done,25));
    }
    expect(turn.completionStatus).toBe("accepted");
    const nodes=turn.completionOutput.rootLayer.nodes;
    expect(nodes.map(node=>node.title)).toEqual(["Coral","Jellyfish","Octopus","Sea turtle","Plankton","Reef monitoring"]);
    expect(nodes.filter(node=>node.icon.kind==="image")).toHaveLength(5);
    for(const node of nodes.slice(0,5)){
      expect(node.icon.digestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(node.authoredDetail.assets).toHaveLength(node.title === "Coral" ? 2 : 1);
    }
    expect(nodes[0].authoredDetail.assets.some(asset => asset.mediaType === "image/svg+xml")).toBe(true);
    expect(nodes[5].authoredDetail).toBeUndefined();
    const exported=await product.exportConversation(thread.id);
    const records=Buffer.from(exported).toString().trim().split("\n").map(JSON.parse);
    expect(records.filter(record=>record.recordType==="visualAssetContent")).toHaveLength(6);
    if(process.env.RELAYER_MARINE_ICON_EVIDENCE_DIR){
      await writeFile(join(process.env.RELAYER_MARINE_ICON_EVIDENCE_DIR,"conversation.jsonl"),exported);
      await writeFile(join(process.env.RELAYER_MARINE_ICON_EVIDENCE_DIR,"accepted-layer.json"),JSON.stringify(turn.completionOutput.rootLayer,null,2));
    }
  }finally{await product?.close();await runtime.close();await rm(directory,{recursive:true,force:true});}
},30_000);
async function request(session,path,options={}){
  const response=await fetch(new URL(path,session.origin),{...options,headers:{Cookie:`${session.cookie.name}=${session.cookie.value}`,...(options.body?{"content-type":"application/json"}:{})}});
  const body=await response.json();if(!response.ok)throw Error(JSON.stringify(body));return body;
}
