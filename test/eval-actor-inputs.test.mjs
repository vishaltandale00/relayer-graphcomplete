import {it,expect} from 'vitest';
import {Window} from 'happy-dom';
import {taskActorOpenedSelect} from '../desktop/eval-main/task-actor-browser.mjs';
import * as actors from '../desktop/eval-main/task-actor.mjs';
import * as setups from '../desktop/eval-main/setup-registry.mjs';
import {participantMayStopIncomplete} from '../desktop/eval-main/evaluator-selection.mjs';
import {decisionActorChoices} from '../desktop/eval-main/decision-task-actor.mjs';

function listFixture(){
 const w=new Window({width:1000,height:600});
 w.document.body.innerHTML='<div class="workspace-layout"><select multiple size="3"><option>A</option><option>B</option><option>C</option><option>Clipped</option><option disabled>Disabled</option><option>Duplicate</option><option>Duplicate</option><optgroup disabled><option>Group disabled</option></optgroup></select></div>';
 w.__taskActorPresentation={threadId:1,turnId:2,layerId:3,selectedNodeId:4,navigationPath:[]};
 const el=w.document.querySelector('select');el.size=3;
 Object.defineProperties(el,{clientHeight:{value:62},clientWidth:{value:198},clientTop:{value:1},clientLeft:{value:1}});
 el.getBoundingClientRect=()=>({left:10,top:10,right:210,bottom:74,width:200,height:64});
 [...el.options].forEach((o,i)=>{Object.defineProperties(o,{label:{value:o.textContent},index:{value:i}});o.getBoundingClientRect=()=>({left:12,top:12+i*20,right:208,bottom:32+i*20,width:196,height:20});});
 w.document.elementFromPoint=()=>el;
 return {el,w};
}
it('exposes only visible enabled unique list rows, binding selection and presentation; legacy remains popup-only',()=>{
 const {el,w}=listFixture();
 expect(taskActorOpenedSelect(el)).toBeNull();
 const first=taskActorOpenedSelect(el,{visibleList:true});
 expect(first?.labels).toEqual(['A','B','C']);
 expect(first.selected).toEqual([]);
 el.options[0].selected=true;
 const second=taskActorOpenedSelect(el,{visibleList:true});
 expect(second.selected).toEqual(['A']);expect(second.signature).not.toBe(first.signature);
 el.multiple=false;expect(taskActorOpenedSelect(el,{visibleList:true}).signature).not.toBe(second.signature);el.multiple=true;
 w.__taskActorPresentation.turnId=9;expect(taskActorOpenedSelect(el,{visibleList:true}).signature).not.toBe(second.signature);
 el.disabled=true;expect(taskActorOpenedSelect(el,{visibleList:true})).toBeNull();
});
it('opts into input actions without changing defaults or letting legacy actors deselect',()=>{
 const old=setups.defaultActorSetup();expect(old.promptVersion).toBe('task-actor-v9');
 expect(typeof setups.inputActorSetup).toBe('function');
 const revised=setups.inputActorSetup();
 expect(revised.behaviorContract.observationContract.id).toBe('task-actor-observation-v4');
 expect(()=>actors.validateActorAction({kind:'deselect',ref:'list',value:'A',reason:'',satisfaction:null,comment:'',endpointStatus:null,remainingWork:''})).toThrow();
 expect(()=>actors.validateActorAction({kind:'deselect',ref:'list',value:'A',reason:'',satisfaction:null,comment:'',endpointStatus:null,remainingWork:''},revised.behaviorContract.actionSchema)).not.toThrow();
 expect(participantMayStopIncomplete({actorSetup:revised},{reason:'abandoned',endpointStatus:'incomplete',remainingWork:'I cannot continue'})).toBe(true);
 expect(revised.promptTemplate).toContain('Filling');expect(revised.promptTemplate).toContain('Send');
});
it('offers select and deselect operations from observed list state only for the new contract',()=>{
 const observation={availableActions:['select','deselect'],controls:[{ref:'list',name:'Signals',role:'select',multiple:true,options:['A','B'],selectedOptions:['A'],optionObservation:'visible-native-list-accessibility'}]};
 const schema={properties:{kind:{enum:['select','deselect']}}};
 expect(decisionActorChoices(observation,schema,false,{contractId:'openai-decisions-codex-text-v2'}).map(x=>x.action)).toMatchObject([{kind:'deselect',value:'A'},{kind:'select',value:'B'}]);
 expect(decisionActorChoices(observation,schema)).toEqual([]);
});
it('publishes and reopens the new revision without promotion or rewriting the prior contract',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'actor-input-revision-'));
 try{
  const options={stateFile:join(dir,'setups.json'),feedbackLoader:async ref=>({ref,comment:'Injected test feedback: selection failed'})};const registry=await new setups.SetupRegistry(options).open();
  const before=registry.selected('actor');
  await expect(registry.publish({...setups.inputActorSetup(),settings:{...setups.inputActorSetup().settings,decision:{contractId:'openai-decisions-codex-text-v1',providerId:'test-openai',model:'gpt-6-luna'}},predecessorId:before.id,feedback:[{sessionId:'fixture',annotationId:'selection-failure'}]})).rejects.toThrow('requires Decisions execution v2');
  const revised=await registry.publish({...setups.inputActorSetup(),settings:{...setups.inputActorSetup().settings,decision:{contractId:'openai-decisions-codex-text-v2',providerId:'test-openai',model:'gpt-6-luna'}},predecessorId:before.id,feedback:[{sessionId:"fixture",annotationId:"selection-failure"}]});
  const reopened=await new setups.SetupRegistry(options).open();
  expect(reopened.selected('actor')).toEqual(before);expect(reopened.get(before.id,'actor')).toEqual(before);
  expect(reopened.get(revised.id,'actor')).toEqual(revised);
  expect(revised.behaviorContract.actionSchema.properties.kind.enum).toContain('deselect');
 }finally{await rm(dir,{recursive:true,force:true});}
});
