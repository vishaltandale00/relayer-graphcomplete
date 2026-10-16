import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {nodeDetailFixtureFactory} from '@relayer/eval-runner';
import {GraphCompleteRuntimeService} from '../desktop/main/services/graphcomplete-runtime.mjs';
import {RelayerAppServerService} from '../desktop/main/services/relayer-app-server.mjs';
import {EvalService} from '../desktop/eval-main/eval-service.mjs';
import {HumanTaskService} from '../desktop/eval-main/human-task-service.mjs';
import {openTaskActorBrowser} from '../desktop/eval-main/task-actor-browser.mjs';
import {INPUT_ACTOR_OBSERVATION_CONTRACT} from '../desktop/eval-main/task-actor.mjs';

async function until(fn){const end=Date.now()+30000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw new Error('Input proof timed out');}
export async function proveActorInputs({browser,service,productSession,data}){
 const tasks=await new HumanTaskService({stateFile:join(data,'actor-input-v4.json'),evalService:service,productSession}).open();
 const task=await tasks.create({testCaseId:'empty-project.visual-node-detail.single-turn',harnessConfigurationName:'fixture-node-detail',maxCompletions:2,endpoint:'Send and inspect a follow-up'});
 await until(async()=>{try{await tasks.settled(tasks.get(task.id));return true;}catch(e){if(e.status!==409)throw e;return false;}});
 const initial=(await tasks.detail(task.currentThreadId)).interactions[0];
 assert.equal(initial.completionStatus,'accepted',JSON.stringify({error:initial.completionError,attempt:initial.latestAttempt}));
 const controller=await openTaskActorBrowser({tasks,sessionId:task.id,productSession,browser,observationContract:INPUT_ACTOR_OBSERVATION_CONTRACT});
 const expected={submittedAt:0,threadId:task.currentThreadId,turnId:tasks.get(task.id).events.find(e=>e.kind==='submission').interactionId};
 await controller.observe(expected);
 const page=browser.contexts().at(-1).pages()[0];
 const get=async name=>{const obs=await controller.observe();const control=obs.controls.find(c=>c.name===name);assert.ok(control,`Visible control ${name}: ${JSON.stringify(await page.locator('#sendInteraction').evaluate(el=>({disabled:el.disabled,title:el.title,name:el.getAttribute('aria-label')})))}`);return control;};
 const refused=action=>assert.rejects(controller.act(action),{code:'actor_control_unavailable',actionDispatched:false});
 try{
  await page.evaluate(()=>{
   const s=document.createElement('select');s.id='list-proof';s.multiple=true;s.size=3;s.setAttribute('aria-label','Signals proof');
   s.style.cssText='position:fixed;top:190px;left:500px;width:220px;z-index:99999';
   s.innerHTML='<option disabled>Disabled</option><option>A</option><option>B</option><option>C</option><option>Duplicate</option><option>Duplicate</option><optgroup disabled><option>Group disabled</option></optgroup>';
   s.addEventListener('input',()=>window.listInputs=(window.listInputs||0)+1);s.addEventListener('change',()=>window.listChanges=(window.listChanges||0)+1);
   document.querySelector('.workspace-layout').append(s);
  });
  let list=await get('Signals proof');assert.deepEqual(list.options,['A','B'],`only fully painted enabled rows: ${JSON.stringify(await page.evaluate(()=>({p:window.__taskActorPresentation,tag:document.querySelector('#list-proof').tagName,multiple:document.querySelector('#list-proof').multiple})))}`);
  await page.evaluate(()=>{const cover=document.createElement('div');cover.id='partial-cover';cover.style.cssText='position:fixed;left:500px;top:180px;width:40px;height:120px;z-index:999999;background:black';document.body.append(cover);});
  list=await get('Signals proof');assert.deepEqual(list.options,[],'partial overlay cannot disclose row labels');
  await page.locator('#partial-cover').evaluate(el=>el.remove());
  await page.locator('#list-proof').evaluate(el=>{const clip=document.createElement('div');clip.id='list-clip';clip.style.cssText='position:fixed;left:500px;top:190px;width:150px;height:100px;overflow:hidden;transform:translateZ(0);z-index:99999';el.before(clip);clip.append(el);el.style.position='relative';el.style.top='0';el.style.left='0';});
  list=await get('Signals proof');assert.deepEqual(list.options,[],'clipping ancestor cannot disclose partial rows');
  await page.locator('#list-proof').evaluate(el=>{const parent=el.parentElement;parent.before(el);parent.remove();el.style.position='fixed';el.style.top='190px';el.style.left='500px';});
  list=await get('Signals proof');
  await refused({kind:'select',ref:list.ref,value:'C'});
  await controller.act({kind:'select',ref:list.ref,value:'A'});
  list=await get('Signals proof');assert.deepEqual(list.selectedOptions,['A']);
  await controller.act({kind:'select',ref:list.ref,value:'B'});
  list=await get('Signals proof');assert.deepEqual(list.selectedOptions,['A','B'],'second choice preserves the first');
  await page.locator('#list-proof').evaluate(el=>{el.options[2].selected=false;});
  await refused({kind:'deselect',ref:list.ref,value:'A'});
  await page.locator('#list-proof').evaluate(el=>{el.options[2].selected=true;});
  list=await get('Signals proof');
  const turn=await page.evaluate(()=>window.__taskActorPresentation.turnId);
  await page.evaluate(()=>{window.__taskActorPresentation.turnId='changed-proof';});
  await refused({kind:'deselect',ref:list.ref,value:'A'});
  await page.evaluate(t=>{window.__taskActorPresentation.turnId=t;},turn);
  list=await get('Signals proof');await controller.act({kind:'deselect',ref:list.ref,value:'A'});
  list=await get('Signals proof');assert.deepEqual(list.selectedOptions,['B'],'deselection preserves other choices');
  await page.locator('#list-proof').evaluate(el=>{el.multiple=false;});
  await refused({kind:'select',ref:list.ref,value:'A'});
  await page.locator('#list-proof').evaluate(el=>{el.multiple=true;});
  assert.deepEqual(await page.evaluate(()=>[window.listInputs,window.listChanges]),[3,3],'normal input and change events');
  await page.locator('#list-proof').evaluate(el=>{el.size=8;});
  list=await get('Signals proof');assert.deepEqual(list.options,['A','B','C'],'disabled, duplicate and disabled-group names unavailable');
  await page.locator('#list-proof').evaluate(el=>{el.replaceWith(el.cloneNode(true));});
  await refused({kind:'select',ref:list.ref,value:'A'});
  await page.locator('#list-proof').evaluate(el=>el.remove());
  // Legacy contracts do not gain list inventories or deselection authority.
  const legacy=await openTaskActorBrowser({tasks,sessionId:task.id,productSession,browser,observationContract:{id:'task-actor-observation-v3',optionObservation:'opened-native-select-accessibility'}});
  try{
   await legacy.observe(expected);
   const oldPage=browser.contexts().at(-1).pages()[0];
   await oldPage.evaluate(()=>{const s=document.createElement('select');s.multiple=true;s.size=2;s.setAttribute('aria-label','Legacy list');s.style.cssText='position:fixed;top:190px;left:500px;z-index:99999';s.innerHTML='<option>A</option><option>B</option>';document.querySelector('.workspace-layout').append(s);});
   const old=(await legacy.observe()).controls.find(c=>c.name==='Legacy list');assert.equal(old.options,undefined);
   await assert.rejects(legacy.act({kind:'select',ref:old.ref,value:'A'}),{code:'actor_control_unavailable',actionDispatched:false});
  }finally{await legacy.close();}
  await page.evaluate(async()=>{
   const {mountCompiledNodeDetail}=await import('/src/product-workspace/node-detail-runtime.js');
   const {validateInputStage}=await import('/src/node-input-controls.js');
   const wrapper=document.createElement('div');wrapper.id='authored-list-wrapper';wrapper.style.cssText='position:fixed;top:190px;left:500px;width:240px;z-index:99999';document.querySelector('.workspace-layout').append(wrapper);
   const host=document.createElement('div');host.id='authored-list-proof';wrapper.append(host);
   const content={version:1,components:[{id:'form',order:0,html:'<select multiple aria-label="Partial signals" data-gc-mount="signals"></select>',css:'select{width:220px}'}],assets:[],mounts:[{id:'signals',componentId:'form',kind:'capability',host:'select',capability:{kind:'input',action:{clientKey:'signals',sourceNode:{clientKey:'question'},sourceLayer:{clientKey:'root'}}}}]};
   const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(content)));
   const detail={...content,integritySha256:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')};
   const action={id:1,kind:'input',control:'multi_select',minimumSelections:2,options:[{key:'a',label:'A'},{key:'b',label:'B'}]};window.partialCommits=[];
   window.partialRuntime=await mountCompiledNodeDetail({host,detail,resolveAction:()=>action,capabilityState:{signals:{value:[],inputBoundary:'original'}},onInput:async(_a,value)=>{const issue=validateInputStage(action,value);if(issue)throw Error(issue.message);window.partialCommits.push(value);window.partialRuntime.updateCapability('signals',{value,busy:false,error:null});}});
   if(window.partialRuntime.status!=='mounted')throw Error(JSON.stringify(window.partialRuntime));
   const field=host.shadowRoot.querySelector('select');
   const r=field.getBoundingClientRect();
   if(!r.width||!r.height)throw Error('Authored select has no painted box: '+host.shadowRoot.innerHTML);
  });
  let partial=await get('Partial signals');await controller.act({kind:'select',ref:partial.ref,value:'A'});
  partial=await get('Partial signals');assert.deepEqual(partial.selectedOptions,['A']);
  assert.deepEqual(await page.evaluate(()=>({commits:window.partialCommits,invalid:document.querySelector('#authored-list-proof').shadowRoot.querySelector('select').getAttribute('aria-invalid')})),{commits:[],invalid:'true'},'partial edit is refused, not admitted');
  await page.evaluate(()=>window.partialRuntime.updateCapability('signals',{value:[],disabled:false,inputBoundary:'original'}));
  partial=await get('Partial signals');assert.deepEqual(partial.selectedOptions,['A'],'ordinary capability refresh retains partial draft');
  await controller.act({kind:'select',ref:partial.ref,value:'B'});
  partial=await get('Partial signals');assert.deepEqual(partial.selectedOptions,['A','B']);
  assert.deepEqual(await page.evaluate(()=>window.partialCommits),[['a','b']],'valid combined selection commits once');
  await controller.act({kind:'deselect',ref:partial.ref,value:'B'});
  partial=await get('Partial signals');assert.deepEqual(partial.selectedOptions,['A']);
  assert.deepEqual(await page.evaluate(()=>window.partialCommits),[['a','b']],'refused correction stays local');
  await page.evaluate(()=>{window.partialRuntime.updateCapability('signals',{value:[],inputBoundary:'different'});});
  partial=await get('Partial signals');assert.deepEqual(partial.selectedOptions,[],'changed authority boundary clears local draft');
  await page.evaluate(()=>{window.partialRuntime.dispose();document.querySelector('#authored-list-wrapper').remove();});
  const composer=await get('Follow up…');
  await controller.act({kind:'fill',ref:composer.ref,value:'Use these choices in the next response.'});
  const send=await get('Send');await controller.act({kind:'click',ref:send.ref});
  const detail=await until(async()=>{const d=await tasks.detail(task.currentThreadId);return d.interactions.length===2&&d.interactions.every(t=>t.completionStatus==='accepted')?d:null;});
  assert.equal(detail.interactions[1].text,'Use these choices in the next response.');
  assert.equal(tasks.get(task.id).completions,2);
  assert.equal(tasks.get(task.id).events.filter(e=>e.kind==='submission'&&!e.initial).length,1);
  await controller.observe({submittedAt:0,threadId:task.currentThreadId,turnId:detail.interactions[1].id});
  console.log('PASS actor input v4: visible rows, additive selection/deselection, normal events, stale state/scope/replacement rejection, legacy isolation, authored minimum-two refusal/refresh/correction, named Send and accepted second response');
 }finally{await controller.close();}
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const data=await mkdtemp(join(tmpdir(),'actor-input-v4-proof-'));const owned=[];
 try{
  const root=resolve('.'),configs=[join(root,'harnesses/fixture-node-detail.yaml')],bin=resolve(process.env.CARGO_TARGET_DIR||'target','debug');
  const runtime=new GraphCompleteRuntimeService({userDataDirectory:data,graphServerBinary:join(bin,'relayer-graph-server'),configurationPaths:configs,additionalImplementations:{'fixture.node-detail':nodeDetailFixtureFactory},acquireProviderExecution:async providerId=>({definition:{id:providerId,adapterId:'codex-subscription',accessContract:'managed-runtime@1'},descriptor:{adapterId:'codex-subscription',accessContract:'managed-runtime@1',implementationVersion:'1'},runtime:{executionAccess:async()=>({kind:'managed-runtime',environment:{}})},release:async()=>{}})});owned.push(runtime);
  const runtimeSession=await runtime.start();
  const product=new RelayerAppServerService({userDataDirectory:data,binaryPath:join(bin,'relayer-app-server'),webDirectory:join(root,'desktop/renderer'),permissionCatalogPath:join(root,'permissions/desktop.json'),runtimeSession,defaultHarnessConfiguration:'fixture-node-detail',allowHarnessOverride:true,evalMode:true,enableReadOnlySession:true});owned.push(product);
  const productSession=await product.start();
  await product.seedProviderCatalog({providerId:'codex',label:'Fixture route',connected:true,models:[{id:'gpt-6.1-sol',label:'Luna',order:0,visible:true,available:true,providerDefault:true,metadata:{}}],systemFamily:{key:'codex',name:'Codex',modelIds:['gpt-6.1-sol']}});
  const request=async(path,method,body)=>{const r=await fetch(new URL(path,productSession.origin),{method,headers:{Cookie:`${productSession.cookie.name}=${productSession.cookie.value}`,'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;};
  const family=await request('/api/model-families','POST',{name:'Input proof fixture',enabled:true,members:[{providerId:'codex',modelId:'gpt-6.1-sol'}]});
  await request('/api/model-settings/defaults','PUT',{harnessId:'fixture-node-detail',familyId:family.id,providerId:'codex',modelId:'gpt-6.1-sol'});
  const service=await new EvalService({stateFile:join(data,'runs.json'),productSession,configurationPaths:configs}).open();owned.push(service);
  const browser=await chromium.launch();owned.push(browser);
  await proveActorInputs({browser,service,productSession,data});
 }finally{for(const r of owned.reverse())await r.close?.();await rm(data,{recursive:true,force:true});}
}
