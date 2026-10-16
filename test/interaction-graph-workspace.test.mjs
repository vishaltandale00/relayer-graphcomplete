import { Window } from "happy-dom";
import { afterEach,it,expect,vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

afterEach(()=>vi.unstubAllGlobals());
it.each(["failed", "stopped", "running", "pending"])("keeps %s local turns selectable while preserving response reset and provenance guards",async(status)=>{
 const window=new Window({url:"http://127.0.0.1:3000"});
 vi.stubGlobal("document",window.document);vi.stubGlobal("window",window);
 vi.stubGlobal("lucide",new Proxy({Circle:{},createElement:()=>window.document.createElement("svg")},{get:(t,k)=>t[k]??{}}));
 window.document.body.innerHTML='<section id="threadView"></section>';
 const node={id:1,kind:"concept",icon:"box",title:"Response",detail:"Body"};
 const layer={layer:{id:91,nodes:[1],defaultNodeId:1},nodes:[node],edges:[],actions:[]};
 const turn={id:5,graphNodeId:50,threadId:801,text:"Question",completionStatus:"accepted",contexts:[],completionOutput:{rootLayer:layer},interactionGraph:{enabled:true,complete:true,sources:[{interactionId:4,threadId:801,text:"Active origin",completionStatus:"running",layers:[],invocationActionId:9}]}};
 const state={status:"accepted",currentInteractionId:5,interactions:[turn,{id:6,threadId:801,text:"Inspect local state",completionStatus:status,contexts:[],interactionGraph:{enabled:true,complete:true,sources:[]}}],visibleLayer:layer,nodes:[node],actions:[],projects:[],permissionProfiles:[],modelSettings:{defaults:{harnessId:"fixture"},harnesses:[{id:"fixture",available:true}],providers:[],families:[]},modelCatalog:[],actionInvocations:[],pendingActionInvocations:[]};
 const selection={currentThreadId:801,currentInteractionId:5,selectedNodeId:null,layerPath:[]};
 const select=vi.fn();
 const workspace=createProductWorkspace({root:window.document,getState:()=>state,getThread:()=>({id:801,title:"Thread",harnessId:"fixture"}),selection,onSelectTurnById:select,showThread(){},showEmpty(){}});
 try {
  workspace.render();await window.happyDOM.waitUntilComplete();
  const trigger=window.document.querySelector("#turnPickerButton");const popover=window.document.querySelector("#turnPopover");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");expect(popover.classList.contains("hidden")).toBe(true);
  expect(trigger.getAttribute("aria-label")).toContain("interaction graph");
  expect(window.document.querySelector("#previousTurn").classList.contains("hidden")).toBe(true);
  trigger.click();expect(popover.classList.contains("hidden")).toBe(false);
  const viewport = popover.querySelector('.interaction-graph-viewport');
  viewport.scrollTop = 80; viewport.scrollLeft = 40;
  workspace.render();await window.happyDOM.waitUntilComplete();
  expect(popover.querySelector('.interaction-graph-viewport').scrollTop).toBe(80);
  expect(popover.querySelector('.interaction-graph-viewport').scrollLeft).toBe(40);
  const active = window.document.querySelector('.interaction-graph-node[data-turn-id="4"]');
  expect(active.disabled).toBe(true);active.click();expect(select).not.toHaveBeenCalled();
  window.document.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
  expect(popover.classList.contains("hidden")).toBe(true);expect(window.document.activeElement).toBe(trigger);
  trigger.click();window.document.querySelector('.interaction-graph-node[data-turn-id="5"]').click();
  await window.happyDOM.waitUntilComplete();
  expect(select).toHaveBeenCalledWith("5",{responseRoot:true,threadId:801});expect(popover.classList.contains("hidden")).toBe(true);
  trigger.click();
  const local = window.document.querySelector('.interaction-graph-node[data-turn-id="6"]');
  expect(local.disabled).toBe(false);local.click();
  await window.happyDOM.waitUntilComplete();
  expect(select).toHaveBeenLastCalledWith("6",{responseRoot:false,threadId:801});
  expect(popover.classList.contains("hidden")).toBe(true);
  delete turn.interactionGraph;workspace.render();await window.happyDOM.waitUntilComplete();
  expect(trigger.textContent).toBe("Turn 1 of 2");expect(window.document.querySelector("#previousTurn").classList.contains("hidden")).toBe(false);
 }finally{workspace.dispose?.();await window.happyDOM.close();}
});
