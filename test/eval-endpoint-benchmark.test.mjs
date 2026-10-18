import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SetupRegistry,defaultActorSetup,inputActorSetup,endpointBenchmarkActorSetup} from '../desktop/eval-main/setup-registry.mjs';
import {actorConfiguration,actorPrompt} from '../desktop/eval-main/task-actor.mjs';
import {participantMayStopIncomplete} from '../desktop/eval-main/evaluator-selection.mjs';

it.each(['native','decisions'])('publishes and reopens an explicitly selected endpoint benchmark without changing ordinary %s actors',async engine=>{
 const dir=await mkdtemp(join(tmpdir(),'endpoint-benchmark-'));
 try{
  const options={stateFile:join(dir,'setups.json'),feedbackLoader:async ref=>({ref,comment:'Injected fixture feedback: require the same endpoint for comparison'})};
  const registry=await new SetupRegistry(options).open();const baseline=registry.selected('actor');
  const feedback=[{sessionId:'fixture',annotationId:'benchmark-endpoint'}];
  const input=inputActorSetup();
  if(engine==='decisions')input.settings.decision={contractId:'openai-decisions-codex-text-v2',providerId:'fixture-openai',model:'gpt-6-luna'};
  const prior=await registry.publish({...input,predecessorId:baseline.id,feedback});
  const definition=registry.catalog().actorEndpointDefinition;
  expect(definition).toEqual(endpointBenchmarkActorSetup());
  definition.settings={...definition.settings,...(input.settings.decision?{decision:input.settings.decision}:{})};
  const benchmark=await registry.publish({...definition,predecessorId:prior.id,feedback});
  await expect(registry.publish({...definition,behaviorContract:{...definition.behaviorContract,participantMayStopIncomplete:true},predecessorId:benchmark.id,feedback})).rejects.toThrow('authority contract');
  await expect(registry.publish({...definition,settings:{...definition.settings,decision:{contractId:'openai-decisions-codex-text-v1',providerId:'fixture-openai',model:'gpt-6-luna'}},predecessorId:benchmark.id,feedback})).rejects.toThrow('requires Decisions execution v2');
  const reopened=await new SetupRegistry(options).open();
  expect(reopened.selected('actor')).toEqual(baseline);
  expect(reopened.get(prior.id,'actor')).toEqual(prior);
  expect(reopened.selected('actor',benchmark.id)).toEqual(benchmark);
  expect(benchmark).toMatchObject({promptVersion:'task-actor-v11',settings:{promptVersion:'task-actor-v11'},behaviorContract:{id:'task-actor-v8',participantMayStopIncomplete:false,observationContract:{id:'task-actor-observation-v4'}}});
  expect(prior.behaviorContract.participantMayStopIncomplete).toBe(true);
  expect(defaultActorSetup()).toEqual(registry.catalog().actorDefinition);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('renders benchmark guidance through native prompt fallback while preserving ordinary unfinished stopping',()=>{
 const prompt=actorPrompt({config:actorConfiguration({promptVersion:'task-actor-v11'}),request:'Deploy',endpoint:'Plan with rollback trigger',privateBrief:'Canary'});
 expect(prompt).toContain('endpoint-completion benchmark');expect(prompt).toContain('Filling a field stages a draft');expect(prompt).toContain('must approve');
 for(const reason of ['satisfied','abandoned']){
  const action={reason,endpointStatus:'incomplete',remainingWork:'Rollback trigger missing'};
  expect(participantMayStopIncomplete({actorSetup:endpointBenchmarkActorSetup()},action)).toBe(false);
  expect(participantMayStopIncomplete({actorSetup:inputActorSetup()},action)).toBe(true);
 }
});
