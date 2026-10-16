import { expect, it } from "vitest";
import { gradeLivingPlanExecution } from "../desktop/eval-main/living-plan-case.mjs";

const published=(sequence,owner,id,reads=[])=>({sequence,method:"POST",path:"/api/graph/plans",status:200,planOwnerInteractionNodeId:owner,planNodeId:id,readPlanNodeIds:reads});
const read=(sequence,owner,id)=>({sequence,method:"GET",path:`/api/graph/plans/${id}`,status:200,planOwnerInteractionNodeId:owner,planNodeId:id});
const search=(sequence)=>({sequence,method:"POST",path:"/api/graph/search",status:200});
const returned=(sequence)=>({sequence,method:"POST",path:"/api/graph/submit",status:200});
async function grade(mutate=()=>{}) {
  const execution={turns:[{interactionId:1},{interactionId:2}],semanticChildren:[{graphNodeId:3,status:"accepted",resultCompletionStatus:"accepted",durable:true}]};
  const ledgers=[
    [search(1),published(2,1,11),read(3,3,31),published(4,1,12,[31]),returned(5)],
    [search(6),read(7,1,12),published(8,2,21,[12]),returned(9)],
  ];
  mutate(execution,ledgers);
  return gradeLivingPlanExecution({execution,interactions:[{interaction:{graphNodeId:1}},{interaction:{graphNodeId:2}}],loadGraphOperations:async(turn)=>ledgers[turn.interactionId-1]});
}
it("grades the real ledger shape for root, successful child incorporation and follow-up without claiming semantic quality",async()=>{
  const result=await grade();
  expect(result.turns.flatMap(turn=>turn.checks).every(check=>check.passed)).toBe(true);
  expect(result.turns[1].evidence).toMatchObject({interactionNodeId:2,publishedPlanNodeIds:[21],readPlanNodeIds:[12]});
  expect(result.turns[0].evidence.semanticQuality).toContain("separate review");
});
it("refuses absent or failed children, wrong owner, post-Return publications and disconnected read provenance",async()=>{
  const mutants=[
    (execution)=>{execution.semanticChildren=[];},
    (_execution,events)=>{events[1][1].planOwnerInteractionNodeId=99;},
    (_execution,events)=>{events[1][1].planNodeId=99; events[1][2].readPlanNodeIds=[99];},
    (_execution,events)=>{events[0].splice(3,0,read(3.5,99,91)); events[0][4].readPlanNodeIds=[91];},
    (execution)=>{execution.semanticChildren[0].resultCompletionStatus="failed";},
    (_execution,events)=>{events[1][2].planOwnerInteractionNodeId=1;},
    (_execution,events)=>{events[1][2].sequence=10;},
    (_execution,events)=>{events[1][2].readPlanNodeIds=[];},
    (_execution,events)=>{events[0][2].status=403;},
  ];
  for(const mutate of mutants) expect((await grade(mutate)).turns.flatMap(turn=>turn.checks).some(check=>!check.passed)).toBe(true);
});
