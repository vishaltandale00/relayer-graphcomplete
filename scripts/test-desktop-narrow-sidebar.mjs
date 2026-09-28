import { app, BrowserWindow, ipcMain } from "electron";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { registerLayerSelectionIpc } from "../desktop/main/ipc/register-ipc.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";
import { stopRunFixture, waitFor } from "../test/support/stop-run-fixture.mjs";

// Native window proof: no device-metrics emulation or substitute BrowserWindow.
// Local IPC fixtures replace only account, OS preferences, and updater services.
const evidence = resolve(process.env.RELAYER_NARROW_EVIDENCE_DIR || ".relayer/evidence/issue-418-native");
const profile = await mkdtemp(join(tmpdir(), "relayer-narrow-native-"));
app.setPath("userData", profile);
app.setName("Relayer narrow-window verification");
// Keep the process alive through async fixture cleanup; the runner owns its
// final exit status even after destroying the last native window.
app.on("window-all-closed", () => {});
app.commandLine.appendSwitch("disable-gpu");
let window;
let fixture;
let exitCode = 1;
let appearance = "dark";
let channel = "stable";
let drafts = { pendingNewThread: null, threadFollowups: {} };
const results = [];
const rendererErrors = [];
let lastPhase = { label: "startup", at: new Date().toISOString() };
const EXECUTE_JAVASCRIPT_TIMEOUT_MS = 10_000;
const SETTLE_RAF_TIMEOUT_MS = 2_000;
const updateStatus = () => ({ phase: "idle", channel, currentVersion: "0.0.0-evidence" });
const account = { status: "signed-in", channel: "stable", subject: "auth0|native-evidence" };
const tutorial = { status: "dismissed", automaticEligible: false };
const handlers = {
  "account-read": () => account,
  "share-pending": () => null,
  "share-preflight": () => ({ status: "ready" }),
  "share-create": () => { throw new Error("Native layout proof must not publish"); },
  "appearance-read": () => ({ appearance }),
  "appearance-set": (_, value) => ({ appearance: appearance = value }),
  "composer-drafts-read": () => drafts,
  "composer-drafts-write": (_, value) => drafts = value,
  "tutorial-read": () => tutorial,
  "tutorial-begin-automatic": () => ({ ...tutorial, started: false, source: "automatic" }),
  "model-catalog-settings-open": () => ({}),
  "model-catalog-refresh": () => ({ refreshed: true }),
  "update-status": updateStatus,
  "update-check": updateStatus,
  "update-channel": (_, value) => { channel = value; return updateStatus(); },
  "provider-status": () => ({
    hasCompletedOnboarding: true,
    adapters: [{ adapterId: "openai-api", implementationVersion: 2, label: "OpenAI API", accessContract: "secret@1", defaultEndpoint: "https://api.openai.com/v1", endpointEditableDuringCreation: true, connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret", required: true }] } }],
    definitions: [{ id: "fixture-openai", adapterId: "openai-api", adapterLabel: "OpenAI API", label: "Deterministic provider", endpoint: "https://api.openai.com/v1", accessContract: "secret@1", lifecycleState: "active", connected: true }],
  }),
};
registerLayerSelectionIpc({ipcMain,settings:createSettingsStore(profile)});
for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`relayer:${name}`, handler);
function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timed = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); });
  return Promise.race([promise, timed]).finally(() => clearTimeout(timer));
}
async function recordPhase(label, details = {}) {
  const native = { windowFocused: false, windowVisible: false, windowMinimized: false, webContentsFocused: false, webContentsLoading: null };
  try {
    if (window && !window.isDestroyed()) {
      native.windowFocused = window.isFocused();
      native.windowVisible = window.isVisible();
      native.windowMinimized = window.isMinimized();
      native.webContentsFocused = window.webContents.isFocused();
      native.webContentsLoading = window.webContents.isLoading();
    }
  } catch (error) { native.error = String(error); }
  let renderer = null;
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    try {
      renderer = await withTimeout(
        window.webContents.executeJavaScript(`({hidden:document.hidden,visibilityState:document.visibilityState,innerWidth,innerHeight,rafCount:window.__nativeRafCount||0,rafAt:window.__nativeRafAt||null,rafAgeMs:window.__nativeRafAt?performance.now()-window.__nativeRafAt:null})`),
        750,
        "Renderer phase snapshot timed out",
      );
    } catch (error) { renderer = { error: String(error) }; }
  }
  lastPhase = { label, at: new Date().toISOString(), native, renderer, details };
  await appendFile(join(evidence, "native-phases.jsonl"), `${JSON.stringify(lastPhase)}\n`);
  return lastPhase;
}
const evaluate = async (source) => {
  const phase = lastPhase.label;
  try {
    return await withTimeout(
      window.webContents.executeJavaScript(source),
      EXECUTE_JAVASCRIPT_TIMEOUT_MS,
      `executeJavaScript timed out after ${EXECUTE_JAVASCRIPT_TIMEOUT_MS}ms; last phase: ${phase}`,
    );
  } catch (error) {
    await recordPhase("executeJavaScript:failed", { lastPhase: phase, error: String(error), sourceLength: source.length });
    throw error;
  }
};
async function settle(label = "settle") {
  await recordPhase(`${label}:double-raf:begin`);
  try {
    await withTimeout(
      window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"),
      SETTLE_RAF_TIMEOUT_MS,
      `Double requestAnimationFrame did not settle within ${SETTLE_RAF_TIMEOUT_MS}ms (${label})`,
    );
  } catch (error) {
    await recordPhase(`${label}:double-raf:failed`, { error: String(error) });
    throw error;
  }
  await recordPhase(`${label}:double-raf:complete`);
}
async function capture(name) {
  await settle(`capture:${name}`);
  await writeFile(join(evidence, `${name}.png`), (await window.webContents.capturePage()).toPNG());
}
async function sendNativeInput(event) {
  if (!window.isFocused() || !window.webContents.isFocused()) {
    window.focus();
    window.webContents.focus();
    await waitFor('verification window receives native input focus',()=>window.isFocused()&&window.webContents.isFocused(),1500);
  }
  window.webContents.sendInputEvent(event);
}
async function pointerClick(selector) {
  await settle(`pointer:${selector}`);
  const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing pointer target '+${JSON.stringify(selector)});const r=e.getBoundingClientRect(),x=Math.round((r.left+r.right)/2),y=Math.round((r.top+r.bottom)/2),hit=document.elementFromPoint(x,y);return {x,y,visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),hit:e===hit||e.contains(hit),rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},viewport:{width:innerWidth,height:innerHeight}};})()`);
  assert.ok(point.x>=0&&point.x<point.viewport.width&&point.y>=0&&point.y<point.viewport.height,`Native pointer target is in the viewport: ${selector} ${JSON.stringify(point)}`);
  // Project compose actions intentionally reveal on hover or keyboard focus.
  // Move the real pointer, then require the revealed target to receive the hit.
  await sendNativeInput({type:'mouseMove',x:point.x,y:point.y});
  await waitFor(`Native pointer target is revealed and hit-testable: ${selector}`,()=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),hit=document.elementFromPoint(${point.x},${point.y});return e?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&getComputedStyle(e).opacity==='1'&&(e===hit||e.contains(hit))})()`),1500);
  await sendNativeInput({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1});
  await sendNativeInput({type:'mouseUp',x:point.x,y:point.y,button:'left',clickCount:1});
}

async function dispatchBrowserWheel(point, deltaY) {
  // CDP's Input.dispatchMouseEvent sends a browser input event in viewport CSS
  // pixels. Positive deltaY scrolls down; verify its trusted WheelEvent receipt
  // and resulting scroll position on the same production BrowserWindow.
  assert.equal(window.webContents.debugger.isAttached(), false, 'browser-wheel proof owns an unattached debugger session');
  window.webContents.debugger.attach('1.3');
  try {
    await withTimeout(
      window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY,
      }),
      1_500,
      'CDP browser-wheel dispatch timed out',
    );
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
  }
}
async function captureScopeOption(name, selector) {
  await settle(`capture-scope:${name}`);
  const state = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),m=document.querySelector('#scopeMenu');if(!e||!m)throw Error('Missing scope capture target '+${JSON.stringify(selector)});const r=e.getBoundingClientRect(),b=m.getBoundingClientRect();return {scope:e.dataset.scope,project:e.dataset.project||null,visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},menu:{left:b.left,right:b.right,top:b.top,bottom:b.bottom},scrollTop:m.scrollTop};})()`);
  assert.ok(state.visible&&state.rect.width>0&&state.rect.height>0&&state.rect.left>=state.menu.left-.5&&state.rect.right<=state.menu.right+.5&&state.rect.top>=state.menu.top-.5&&state.rect.bottom<=state.menu.bottom+.5,`${name}: capture shows intended scope option fully inside menu ${JSON.stringify(state)}`);
  await writeFile(join(evidence, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  return state;
}
async function resize(width) {
  await recordPhase(`resize:${width}:begin`);
  window.setSize(width, 640);
  await recordPhase(`resize:${width}:setSize-returned`);
  await recordPhase(`resize:${width}:innerWidth-wait:begin`);
  await waitFor(`native width ${width}`, () => evaluate(`innerWidth === ${width}`));
  await recordPhase(`resize:${width}:innerWidth-wait:complete`);
  await settle(`resize:${width}`);
  await recordPhase(`resize:${width}:complete`);
}
async function shell(name, expanded) {
  await recordPhase(`shell:${name}:begin`, { expanded });
  const state = await evaluate(`(() => {
    const box = s => { const e=document.querySelector(s),r=e?.getBoundingClientRect(); return r && {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})}; };
    return {inner:[innerWidth,innerHeight],collapsed:document.body.classList.contains('sidebar-collapsed'),sidebar:box('.sidebar'),main:box('.main-area'),toggle:box('#collapseSidebar'),account:box('#desktopAccountButton'),settings:box('#settingsButton'),scrollWidth:document.documentElement.scrollWidth};
  })()`);
  const animationBounds=await evaluate(`(() => {
    const toggle=document.querySelector('#collapseSidebar');
    const samples=[];
    for(const animation of toggle.getAnimations({subtree:true})) {
      if(animation.transitionProperty!=='transform') continue;
      const time=animation.currentTime,playing=animation.playState==='running';
      animation.pause();
      for(const fraction of [0,.25,.5,.75,1]) {
        animation.currentTime=Number(animation.effect.getTiming().duration)*fraction;
        const r=toggle.getBoundingClientRect();
        samples.push({fraction,left:r.left,top:r.top,right:r.right,bottom:r.bottom});
      }
      animation.currentTime=time;
      if(playing) animation.play();
    }
    return samples;
  })()`);
  if(process.platform==='darwin') assert.ok(animationBounds.every(r=>r.left>=80||r.top>=40), `${name}: animated toggle clearance ${JSON.stringify(animationBounds)}`);
  state.animationBounds=animationBounds;
  assert.equal(state.collapsed, !expanded, name);
  assert.equal(state.sidebar.width, expanded ? 210 : 58, name);
  // hiddenInset reserves the top-left 80x40 region for native macOS controls.
  // A successful center click alone cannot prove the entire toggle is clear.
  if(process.platform==='darwin') assert.ok(state.toggle.left>=80 || state.toggle.top>=40, `${name}: complete toggle hit box clears native titlebar controls ${JSON.stringify(state.toggle)}`);
  assert.ok(Math.abs(state.main.left - state.sidebar.right) <= 1, `${name}: sidebar stays in flow`);
  assert.ok(Math.abs(state.main.width - (state.inner[0] - state.sidebar.width)) <= 1, `${name}: workspace shrinks`);
  for (const key of ["toggle", "account", "settings"]) {
    const r = state[key];
    assert.ok(r?.visible && r.width > 0 && r.height > 0 && r.left >= state.sidebar.left && r.right <= state.sidebar.right && r.top >= 0 && r.bottom <= state.inner[1], `${name}: ${key} visible and contained`);
  }
  assert.ok(state.scrollWidth <= state.inner[0], `${name}: horizontal document overflow`);
  results.push({ name, outer: window.getSize(), content: window.getContentSize(), minimum: window.getMinimumSize(), ...state });
  const auditHeader = async (selectors) => evaluate(`(() => {
    const header=document.querySelector('.thread-header').getBoundingClientRect();
    return ${JSON.stringify(selectors)}.map(selector=>{
      const e=document.querySelector(selector),r=e?.getBoundingClientRect();
      return {selector,visible:e?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),rect:r&&{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},contained:r&&r.left>=header.left-.5&&r.right<=header.right+.5&&r.top>=0&&r.bottom<=innerHeight};
    });
  })()`);
  const headerControls=await auditHeader(['#historyBack','#historyForward','#conversationSettingsButton','#shareConversation']);
  assert.ok(headerControls.every(c=>c.visible&&c.rect.width>0&&c.rect.height>0&&c.contained), `${name}: header controls ${JSON.stringify(headerControls)}`);
  for(let i=0;i<headerControls.length;i++) for(let j=i+1;j<headerControls.length;j++) {
    const a=headerControls[i].rect,b=headerControls[j].rect;
    assert.ok(Math.min(a.right,b.right)-Math.max(a.left,b.left)<=.5 || Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=.5, `${name}: header controls must not overlap`);
  }
  await evaluate("document.querySelector('#conversationSettingsButton').click()");
  const menuControls=await auditHeader(['#conversationSettingsMenu','#shareConversationMenu','#exportConversation']);
  assert.ok(menuControls.every(c=>c.visible&&c.rect.width>0&&c.rect.height>0&&c.contained), `${name}: menu controls ${JSON.stringify(menuControls)}`);
  await capture(`${name}-conversation-menu`);
  await evaluate("document.querySelector('#conversationSettingsButton').click()");
  if([375,620].includes(state.inner[0])) {
    await evaluate("document.querySelector('#shareConversation').click()");
    await waitFor(`${name}: Share title`,()=>evaluate("Boolean(document.querySelector('#shareTitle'))"));
    const dialog=await evaluate(`(() => {
      const selectors=['.share-dialog-card','#shareTitle','[data-share-action="cancel"]','[data-share-action="create"]'];
      return selectors.map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return {selector,visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),positive:r.width>0&&r.height>0,contained:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight};});
    })()`);
    assert.ok(dialog.every(c=>c.visible&&c.positive&&c.contained),`${name}: Share dialog controls ${JSON.stringify(dialog)}`);
    assert.equal(await evaluate("document.querySelector('[data-share-action=\"create\"]').disabled"),true);
    await capture(`${name}-share-title`);
    await evaluate("document.querySelector('#shareTitle').value='Native layout evidence';document.querySelector('#shareTitle').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-share-action=\"cancel\"]').click()");
    assert.equal(await evaluate("document.querySelector('#shareDialog').classList.contains('hidden')"),true);
    results.at(-1).shareDialog=dialog;
  }
  results.at(-1).headerControls=headerControls;
  results.at(-1).menuControls=menuControls;
  await capture(name);
  const composerControls=await evaluate(`(async()=>{
    const selectors=['#threadPrompt','#sendInteraction','#threadComposer [data-model-picker-trigger]'];
    const controls=[];
    for(const selector of selectors) {
      const e=document.querySelector(selector);
      if(!e) throw Error('Missing native composer control '+selector);
      e.scrollIntoView({block:'nearest',inline:'nearest'});
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const r=e.getBoundingClientRect();
      let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
      for(let parent=e.parentElement;parent;parent=parent.parentElement) {
        const style=getComputedStyle(parent);
        const pr=parent.getBoundingClientRect();
        if(['auto','scroll','hidden','clip'].includes(style.overflowX)) {
          clip.left=Math.max(clip.left,pr.left+parent.clientLeft);
          clip.right=Math.min(clip.right,pr.left+parent.clientLeft+parent.clientWidth);
        }
        if(['auto','scroll','hidden','clip'].includes(style.overflowY)) {
          clip.top=Math.max(clip.top,pr.top+parent.clientTop);
          clip.bottom=Math.min(clip.bottom,pr.top+parent.clientTop+parent.clientHeight);
        }
      }
      controls.push({selector,visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),width:r.width,height:r.height,contained:r.left>=clip.left-.5&&r.right<=clip.right+.5&&r.top>=clip.top-.5&&r.bottom<=clip.bottom+.5,clip});
    }
    return controls;
  })()`);
  assert.ok(composerControls.every(c=>c.visible&&c.width>0&&c.height>0&&c.contained), `${name}: native composer reachability ${JSON.stringify(composerControls)}`);
  results.at(-1).composerControls=composerControls;
  await capture(`${name}-composer-scrolled`);
  await evaluate("document.querySelector('.workspace-layout').scrollTop=0");
  await recordPhase(`shell:${name}:complete`, { expanded });
}

async function auditNewThreadComposer(name, threadId, scopeProjects) {
  await evaluate("document.querySelector('#newThread').click()");
  await waitFor(`${name}: New Thread view`,()=>evaluate("!document.querySelector('#newThreadView').classList.contains('hidden')"));
  await evaluate("document.querySelector('#newThreadPrompt').value='keep this draft while choosing a project';document.querySelector('#newThreadPrompt').dispatchEvent(new Event('input',{bubbles:true}))");
  const threadCountBeforeScope = (await fixture.request('/api/state')).threads.length;
  await pointerClick('#scopeButton');
  await waitFor(`${name}: scope menu opens after native pointer input`,()=>evaluate("document.querySelector('#scopeButton').getAttribute('aria-expanded')==='true'"),1500);
  assert.equal(await evaluate("document.querySelector('#scopeButton').getAttribute('aria-expanded')"),'true',`${name}: scope menu open state is exposed accessibly`);
  await evaluate(`(() => {window.__scopeWheelReceipts=[];document.addEventListener('wheel',event=>{const hit=document.elementFromPoint(event.clientX,event.clientY);window.__scopeWheelReceipts.push({isTrusted:event.isTrusted,deltaX:event.deltaX,deltaY:event.deltaY,clientX:event.clientX,clientY:event.clientY,target:event.target?.tagName||null,targetId:event.target?.id||null,hit:hit?.tagName||null,hitId:hit?.id||null,insideMenu:Boolean(hit?.closest('#scopeMenu')),scrollTop:document.querySelector('#scopeMenu')?.scrollTop});},{capture:true,passive:true});})()`);
  const scopeMutations = await evaluate(`(() => {
    const m=document.querySelector('#scopeMenu'),oldMax=m.style.maxBlockSize;
    const read=()=>{const r=m.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight,scrollTop:m.scrollTop,scrollHeight:m.scrollHeight,clientHeight:m.clientHeight,overflowY:getComputedStyle(m).overflowY}};
    m.style.maxBlockSize='none';const uncapped=read();const capWouldReject=uncapped.top<40||uncapped.bottom>innerHeight;m.style.maxBlockSize=oldMax;
    m.style.overflowY='hidden';const hiddenStart=read();
    return {uncapped,capWouldReject,hiddenStart};
  })()`);
  assert.ok(scopeMutations.capWouldReject,`${name}: removing the height cap is detected independently ${JSON.stringify(scopeMutations)}`);
  const hiddenStart=scopeMutations.hiddenStart.scrollTop;
  const hiddenBounds=await evaluate("document.querySelector('#scopeMenu').getBoundingClientRect().toJSON()");
  const hiddenPoint={x:Math.round((hiddenBounds.left+hiddenBounds.right)/2),y:Math.round((hiddenBounds.top+hiddenBounds.bottom)/2)};
  const hiddenHit=await evaluate(`(() => {const point=${JSON.stringify(hiddenPoint)},hit=document.elementFromPoint(point.x,point.y);return {point,hit:hit?.tagName||null,hitId:hit?.id||null,insideMenu:Boolean(hit?.closest('#scopeMenu')),menu:document.querySelector('#scopeMenu').getBoundingClientRect().toJSON(),scrollTop:document.querySelector('#scopeMenu').scrollTop};})()`);
  assert.ok(hiddenHit.insideMenu,`${name}: overflow mutant input point hits the actual scope menu ${JSON.stringify(hiddenHit)}`);
  window.focus();
  await waitFor(`${name}: window focus for native wheel`,()=>window.isFocused()&&window.webContents.isFocused(),1500);
  const focusAtWheel={window:window.isFocused(),webContents:window.webContents.isFocused()};
  await dispatchBrowserWheel(hiddenPoint, 900);
  let hiddenReceiptWaitError=null;
  try { await waitFor(`${name}: hidden overflow wheel receipt`,()=>evaluate("window.__scopeWheelReceipts.length>=1"),1500); } catch(error) { hiddenReceiptWaitError=String(error); }
  const hiddenReceipt=await evaluate("window.__scopeWheelReceipts[0]||null");
  await writeFile(join(evidence,'scope-wheel-diagnostic.json'),JSON.stringify({stage:'hidden-overflow-mutant',scopeMenuBounds:hiddenBounds,hiddenHit,focusAtWheel,hiddenReceipt,hiddenReceiptWaitError},null,2));
  await settle();
  const hiddenAfter=await evaluate("({scrollTop:document.querySelector('#scopeMenu').scrollTop,overflowY:getComputedStyle(document.querySelector('#scopeMenu')).overflowY})");
  assert.ok(hiddenReceipt?.isTrusted&&hiddenReceipt.insideMenu&&hiddenReceipt.deltaY>0,`${name}: positive browser wheel event reaches menu as a trusted downward wheel ${JSON.stringify(hiddenReceipt)}`);
  assert.equal(hiddenAfter.overflowY,'hidden',`${name}: overflow:hidden mutant was applied`);
  assert.equal(hiddenAfter.scrollTop,hiddenStart,`${name}: overflow:hidden mutant rejects real wheel input ${JSON.stringify(hiddenAfter)}`);
  await evaluate("(() => {const m=document.querySelector('#scopeMenu');m.style.maxBlockSize='';m.style.overflowY='';})()");
  const scopeMenu = await evaluate(`(() => {
    const menu=document.querySelector('#scopeMenu'),r=menu.getBoundingClientRect(),style=getComputedStyle(menu);
    const projects=[...menu.querySelectorAll('[data-scope="project"]')];
    const options=[...menu.querySelectorAll('[data-scope]')].map(e=>{const b=e.getBoundingClientRect();return {scope:e.dataset.scope,project:e.dataset.project||null,left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height};});
    const textWidths=[...menu.querySelectorAll('button,button>span,button>small')].map(e=>({tag:e.tagName,text:e.textContent,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}));
    const w=document.querySelector('.main-area').getBoundingClientRect();
    return {rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},workspace:{left:w.left,right:w.right,top:w.top,bottom:w.bottom},viewport:{width:innerWidth,height:innerHeight},overflowY:style.overflowY,scrollTop:menu.scrollTop,scrollHeight:menu.scrollHeight,clientHeight:menu.clientHeight,scrollWidth:menu.scrollWidth,clientWidth:menu.clientWidth,textWidths,projectIds:projects.map(e=>e.dataset.project),options};
  })()`);
  assert.deepEqual([...scopeMenu.projectIds].sort(), scopeProjects.map(project=>String(project.id)).sort(), `${name}: each real project choice appears exactly once`);
  assert.equal(scopeMenu.options.filter(option=>option.scope==='standalone').length,1,`${name}: one No folder choice`);
  assert.equal(scopeMenu.options.filter(option=>option.scope==='folder').length,1,`${name}: one Open another folder choice`);
  assert.ok(scopeMenu.rect.left>=scopeMenu.workspace.left-.5&&scopeMenu.rect.right<=scopeMenu.workspace.right+.5&&scopeMenu.rect.left>=0&&scopeMenu.rect.right<=scopeMenu.viewport.width&&scopeMenu.rect.top>=40&&scopeMenu.rect.bottom<=scopeMenu.viewport.height,`${name}: scope popup fits the remaining workspace, viewport, and titlebar inset ${JSON.stringify(scopeMenu)}`);
  assert.ok(scopeMenu.rect.width>0&&scopeMenu.rect.height>0&&scopeMenu.scrollHeight>scopeMenu.clientHeight&&['auto','scroll'].includes(scopeMenu.overflowY),`${name}: populated scope popup offers native vertical scrolling ${JSON.stringify(scopeMenu)}`);
  assert.ok(scopeMenu.scrollWidth<=scopeMenu.clientWidth+1,`${name}: long project paths wrap without horizontal menu overflow ${JSON.stringify(scopeMenu)}`);
  assert.ok(scopeMenu.textWidths.every(item=>item.scrollWidth<=item.clientWidth+1),`${name}: each project title and path fits its menu row ${JSON.stringify(scopeMenu.textWidths.filter(item=>item.scrollWidth>item.clientWidth+1))}`);
  assert.ok(scopeMenu.options.every(({left,right,width,height})=>left>=scopeMenu.rect.left-.5&&right<=scopeMenu.rect.right+.5&&width>0&&height>0),`${name}: options stay within menu's horizontal viewport`);
  await captureScopeOption(`${name}-scope-first`, '#scopeMenu [data-scope="standalone"]');
  // Use an actual wheel input over the menu so overflow:hidden cannot pass by
  // merely allowing programmatic scrollIntoView or setting scrollTop.
  const wheelX=Math.round((scopeMenu.rect.left+scopeMenu.rect.right)/2),wheelY=Math.round((scopeMenu.rect.top+scopeMenu.rect.bottom)/2);
  const wheelHit=await evaluate(`(() => {const hit=document.elementFromPoint(${wheelX},${wheelY});return {x:${wheelX},y:${wheelY},hit:hit?.tagName||null,hitId:hit?.id||null,insideMenu:Boolean(hit?.closest('#scopeMenu'))};})()`);
  assert.ok(wheelHit.insideMenu,`${name}: real wheel pointer resolves inside the scope menu ${JSON.stringify(wheelHit)}`);
  await dispatchBrowserWheel({x:wheelX,y:wheelY}, Math.max(800,scopeMenu.scrollHeight));
  let scrollWaitError=null;
  try { await waitFor(`${name}: native downward wheel scroll`,()=>evaluate("document.querySelector('#scopeMenu').scrollTop>0"),1500); } catch(error) { scrollWaitError=String(error); }
  const wheelReach = await evaluate(`(() => {const m=document.querySelector('#scopeMenu'),last=[...m.querySelectorAll('[data-scope="project"]')].at(-1),r=last.getBoundingClientRect(),receipts=window.__scopeWheelReceipts||[];return {scrollTop:m.scrollTop,scrollHeight:m.scrollHeight,clientHeight:m.clientHeight,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},wheelReceipts:receipts,scrollWaitError:${JSON.stringify(scrollWaitError)}};})()`);
  await writeFile(join(evidence,'scope-wheel-diagnostic.json'),JSON.stringify({stage:'downward-wheel',scopeMenu,wheelHit,hiddenHit,focusAtWheel,hiddenReceipt,hiddenReceiptWaitError,hiddenAfter,wheelReach},null,2));
  assert.ok(wheelReach.wheelReceipts.length>=2&&wheelReach.wheelReceipts.at(-1).isTrusted&&wheelReach.wheelReceipts.at(-1).insideMenu&&wheelReach.wheelReceipts.at(-1).deltaY>0,`${name}: positive browser wheel event reaches scope menu as a trusted downward wheel ${JSON.stringify(wheelReach.wheelReceipts)}`);
  assert.ok(wheelReach.scrollTop>0,`${name}: native wheel scroll changes the menu scroll position ${JSON.stringify(wheelReach)}`);
  assert.ok(wheelReach.rect.left>=scopeMenu.rect.left-.5&&wheelReach.rect.right<=scopeMenu.rect.right+.5&&wheelReach.rect.top>=scopeMenu.rect.top-.5&&wheelReach.rect.bottom<=scopeMenu.rect.bottom+.5,`${name}: last project is reachable within effective menu clip ${JSON.stringify(wheelReach)}`);
  const focusedItems=[];
  for(let index=0;index<scopeMenu.options.length;index++) {
    await sendNativeInput({type:'keyDown',keyCode:'TAB'});
    await sendNativeInput({type:'keyUp',keyCode:'TAB'});
    await settle();
    const focused=await evaluate(`(() => {const e=document.activeElement,m=document.querySelector('#scopeMenu'),r=e.getBoundingClientRect();let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};for(let p=e.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(['auto','scroll','hidden','clip'].includes(s.overflowX)){clip.left=Math.max(clip.left,b.left+p.clientLeft);clip.right=Math.min(clip.right,b.left+p.clientLeft+p.clientWidth)}if(['auto','scroll','hidden','clip'].includes(s.overflowY)){clip.top=Math.max(clip.top,b.top+p.clientTop);clip.bottom=Math.min(clip.bottom,b.top+p.clientTop+p.clientHeight)}}return {scope:e.dataset.scope||null,project:e.dataset.project||null,label:e.innerText||'',visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},clip,scrollTop:m.scrollTop};})()`);
    const expected=scopeMenu.options[index];
    assert.equal(focused.scope,expected.scope,`${name}: keyboard focus order at option ${index}`);
    assert.equal(focused.project,expected.project,`${name}: keyboard focus uses exact project id at option ${index}`);
    assert.ok(focused.visible&&focused.rect.width>0&&focused.rect.height>0&&focused.rect.left>=focused.clip.left-.5&&focused.rect.right<=focused.clip.right+.5&&focused.rect.top>=focused.clip.top-.5&&focused.rect.bottom<=focused.clip.bottom+.5,`${name}: focused option ${index} is visibly reachable ${JSON.stringify(focused)}`);
    focusedItems.push({scope:focused.scope,project:focused.project,scrollTop:focused.scrollTop});
    if(expected.scope==='project'&&expected.project===String(scopeProjects.at(-1).id)) await captureScopeOption(`${name}-scope-last`, '#scopeMenu [data-scope="project"]:nth-last-child(2)');
  }
  assert.ok(focusedItems.at(-1).scrollTop>focusedItems[0].scrollTop,`${name}: tab traversal scrolls through the menu`);
  const menuButton = await evaluate(`(() => {const e=[...document.querySelectorAll('#scopeMenu [data-scope="project"]')].at(-1),r=e.getBoundingClientRect();return {x:Math.round((r.left+r.right)/2),y:Math.round((r.top+r.bottom)/2)};})()`);
  await sendNativeInput({type:'mouseDown',x:menuButton.x,y:menuButton.y,button:'left',clickCount:1});
  await sendNativeInput({type:'mouseUp',x:menuButton.x,y:menuButton.y,button:'left',clickCount:1});
  await waitFor(`${name}: selected late project`,()=>evaluate(`import('./src/state.js').then(m=>m.viewState.selectedScope.kind==='project'&&String(m.viewState.selectedScope.projectId)===${JSON.stringify(String(scopeProjects.at(-1).id))})`));
  assert.equal(await evaluate("document.querySelector('#newThreadPrompt').value"),'keep this draft while choosing a project',`${name}: scope selection keeps the composer draft`);
  assert.equal(await evaluate("document.querySelector('#scopeButton').getAttribute('aria-expanded')"),'false',`${name}: selecting a project closes the menu`);
  assert.equal(await evaluate("document.querySelector('#scopeLabel').textContent"),scopeProjects.at(-1).name,`${name}: project scope label reflects the selected project`);
  assert.equal((await fixture.request('/api/state')).threads.length,threadCountBeforeScope,`${name}: selecting scope does not create a thread before Send`);
  await pointerClick('#scopeButton');
  await waitFor(`${name}: scope menu reopens after native pointer input`,()=>evaluate("document.querySelector('#scopeButton').getAttribute('aria-expanded')==='true'"),1500);
  await sendNativeInput({type:'keyDown',keyCode:'TAB'});
  await sendNativeInput({type:'keyUp',keyCode:'TAB'});
  await settle();
  const standalone = await evaluate(`(() => {const e=document.activeElement,m=document.querySelector('#scopeMenu'),r=e.getBoundingClientRect(),b=m.getBoundingClientRect();return {scope:e.dataset.scope||null,visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},menu:{left:b.left,right:b.right,top:b.top,bottom:b.bottom}};})()`);
  assert.equal(standalone.scope,'standalone',`${name}: reopening the menu tabs to No folder`);
  assert.ok(standalone.visible&&standalone.rect.width>0&&standalone.rect.height>0&&standalone.rect.left>=standalone.menu.left-.5&&standalone.rect.right<=standalone.menu.right+.5&&standalone.rect.top>=standalone.menu.top-.5&&standalone.rect.bottom<=standalone.menu.bottom+.5,`${name}: No folder is keyboard-reachable inside the menu ${JSON.stringify(standalone)}`);
  await evaluate("(() => {window.__scopeEnterReceipts=[];for(const type of ['keydown','keypress','keyup'])document.addEventListener(type,event=>{if(event.key==='Enter'||event.key==='\\r')window.__scopeEnterReceipts.push({type,key:event.key,code:event.code,isTrusted:event.isTrusted,target:event.target?.dataset?.scope||event.target?.tagName||null});},{capture:true});})()");
  await sendNativeInput({type:'keyDown',keyCode:'ENTER'});
  // Electron's keyDown input is rawKeyDown; the separate char event generates
  // the trusted keypress used by the browser's native button activation.
  await sendNativeInput({type:'char',keyCode:'ENTER'});
  await sendNativeInput({type:'keyUp',keyCode:'ENTER'});
  await waitFor(`${name}: trusted native Enter key sequence`,()=>evaluate("window.__scopeEnterReceipts.some(event=>event.type==='keydown')&&window.__scopeEnterReceipts.some(event=>event.type==='keypress')&&window.__scopeEnterReceipts.some(event=>event.type==='keyup')"),1500);
  const enterReceipt=await evaluate("window.__scopeEnterReceipts");
  assert.deepEqual(enterReceipt.map(event=>event.type),['keydown','keypress','keyup'],`${name}: Enter produces the native keydown/keypress/keyup sequence ${JSON.stringify(enterReceipt)}`);
  assert.ok(enterReceipt.every(event=>event.isTrusted),`${name}: Enter sequence is trusted browser input ${JSON.stringify(enterReceipt)}`);
  await waitFor(`${name}: standalone scope`,()=>evaluate("import('./src/state.js').then(m=>m.viewState.selectedScope.kind==='standalone')"));
  assert.equal(await evaluate("document.querySelector('#newThreadPrompt').value"),'keep this draft while choosing a project',`${name}: No folder keeps the composer draft`);
  assert.equal(await evaluate("document.querySelector('#scopeLabel').textContent"),'No folder',`${name}: No folder label is restored`);
  assert.equal(await evaluate("document.querySelector('#folderSummary').classList.contains('hidden')"),true,`${name}: standalone selection clears project path summary`);
  assert.equal(await evaluate("document.querySelector('#scopeButton').getAttribute('aria-expanded')"),'false',`${name}: Enter closes the No folder menu`);
  assert.equal((await fixture.request('/api/state')).threads.length,threadCountBeforeScope,`${name}: No folder does not create a thread before Send`);
  results.push({name:`${name}-scope-menu`,scopeMenu,scopeMutations:{uncapped:scopeMutations.uncapped,capWouldReject:scopeMutations.capWouldReject,overflowHiddenStart:hiddenStart,overflowHiddenAfter:hiddenAfter,overflowHiddenBlocksWheel:hiddenAfter.scrollTop===hiddenStart},wheelReach,focusedItems,enterReceipt,selectedProjectId:String(scopeProjects.at(-1).id),selectedStandalone:true,threadCountBeforeScope});
  const controls=await evaluate(`(async()=>{
    const selectors=['#newThreadPrompt','#scopeButton','#permissionButton','#newModelControl [data-model-picker-trigger]','#createThread'];
    const result=[];
    for(const selector of selectors) {
      const e=document.querySelector(selector);
      if(!e) throw Error('Missing New Thread composer control '+selector);
      e.scrollIntoView({block:'nearest',inline:'nearest'});
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const r=e.getBoundingClientRect();
      let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
      for(let parent=e.parentElement;parent;parent=parent.parentElement) {
        const style=getComputedStyle(parent),pr=parent.getBoundingClientRect();
        if(['auto','scroll','hidden','clip'].includes(style.overflowX)) {clip.left=Math.max(clip.left,pr.left+parent.clientLeft);clip.right=Math.min(clip.right,pr.left+parent.clientLeft+parent.clientWidth);}
        if(['auto','scroll','hidden','clip'].includes(style.overflowY)) {clip.top=Math.max(clip.top,pr.top+parent.clientTop);clip.bottom=Math.min(clip.bottom,pr.top+parent.clientTop+parent.clientHeight);}
      }
      result.push({selector,visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),enabled:!('disabled'in e)||!e.disabled,width:r.width,height:r.height,contained:r.left>=clip.left-.5&&r.right<=clip.right+.5&&r.top>=clip.top-.5&&r.bottom<=clip.bottom+.5,clip});
    }
    return result;
  })()`);
  assert.ok(controls.every(c=>c.visible&&c.width>0&&c.height>0&&c.contained),`${name}: New Thread composer reachability ${JSON.stringify(controls)}`);
  results.push({name,controls});
  await capture(name);
  await evaluate(`document.querySelector('[data-thread="${threadId}"]').click()`);
  await waitFor(`${name}: return to saved thread`,()=>evaluate(`import('./src/state.js').then(m=>m.viewState.mainView==='thread'&&String(m.viewState.currentThreadId)===${JSON.stringify(String(threadId))})`));
}

async function auditTurnPickerLayout(threadId, turnIds, annotatedTurnId) {
  const scenarios = [];
  for (const [width, expanded] of [[375, true], [375, false], [483, true]]) {
    await resize(width);
    const collapsed = await evaluate("document.body.classList.contains('sidebar-collapsed')");
    if (collapsed === expanded) await pointerClick('#collapseSidebar');
    await waitFor(`turn picker ${width}px sidebar state`, () => evaluate(`document.body.classList.contains('sidebar-collapsed')===${!expanded}`));
    await pointerClick('#turnPickerButton');
    await waitFor(`turn picker opens at ${width}px`, () => evaluate("document.querySelector('#turnPickerButton').getAttribute('aria-expanded')==='true'"), 1_500);
    const state = await evaluate(`(() => {
      const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
      const menu=document.querySelector('#turnPopover'),pane=document.querySelector('.main-area'),r=menu.getBoundingClientRect(),p=pane.getBoundingClientRect();
      let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
      for(let a=menu.parentElement;a;a=a.parentElement){const s=getComputedStyle(a),b=a.getBoundingClientRect();if(['auto','scroll','hidden','clip'].includes(s.overflowX)){clip.left=Math.max(clip.left,b.left+a.clientLeft);clip.right=Math.min(clip.right,b.left+a.clientLeft+a.clientWidth)}if(['auto','scroll','hidden','clip'].includes(s.overflowY)){clip.top=Math.max(clip.top,b.top+a.clientTop);clip.bottom=Math.min(clip.bottom,b.top+a.clientTop+a.clientHeight)}}
      const rows=[...menu.querySelectorAll('.turn-option')].map(row=>{const prompt=row.querySelector('.turn-option-prompt'),meta=row.querySelector('.turn-option-meta'),status=row.querySelector('.turn-option-status'),comments=row.querySelector('.turn-option-comments');const child=e=>{if(!e)return null;const r=e.getBoundingClientRect();let c={left:0,top:0,right:innerWidth,bottom:innerHeight};for(let a=e.parentElement;a;a=a.parentElement){const s=getComputedStyle(a),b=a.getBoundingClientRect();if(['auto','scroll','hidden','clip'].includes(s.overflowX)){c.left=Math.max(c.left,b.left+a.clientLeft);c.right=Math.min(c.right,b.left+a.clientLeft+a.clientWidth)}if(['auto','scroll','hidden','clip'].includes(s.overflowY)){c.top=Math.max(c.top,b.top+a.clientTop);c.bottom=Math.min(c.bottom,b.top+a.clientTop+a.clientHeight)}}return{...box(e),visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),contained:r.left>=row.getBoundingClientRect().left-.5&&r.right<=row.getBoundingClientRect().right+.5&&r.top>=row.getBoundingClientRect().top-.5&&r.bottom<=row.getBoundingClientRect().bottom+.5,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}};return {id:row.dataset.turnId,current:row.getAttribute('aria-current')==='true',focused:document.activeElement===row,rect:box(row),visible:row.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),sequence:child(row.querySelector('.turn-option-number')),prompt:child(prompt),promptText:prompt.textContent,promptScrollWidth:prompt.scrollWidth,promptClientWidth:prompt.clientWidth,meta:child(meta),status:child(status),statusText:status?.textContent||'',comments:child(comments),commentsText:comments?.textContent||''}});
      return {menu:box(menu),pane:box(pane),clip,overflowY:getComputedStyle(menu).overflowY,scrollTop:menu.scrollTop,scrollHeight:menu.scrollHeight,clientHeight:menu.clientHeight,scrollWidth:menu.scrollWidth,clientWidth:menu.clientWidth,rows,activeId:document.activeElement?.dataset?.turnId||null};
    })()`);
    const currentTurnId=await evaluate("import('./src/state.js').then(m=>String(m.viewState.currentInteractionId))");
    assert.equal(state.rows.length, turnIds.length, `${width}: all saved and live turns are rendered in history`);
    assert.deepEqual(state.rows.map(row=>row.id), turnIds, `${width}: turn picker retains exact interaction IDs`);
    assert.ok(state.menu.left>=state.pane.left-.5&&state.menu.right<=state.pane.right+.5&&state.menu.left>=state.clip.left-.5&&state.menu.right<=state.clip.right+.5&&state.menu.top>=state.clip.top-.5&&state.menu.bottom<=state.clip.bottom+.5, `${width}: turn picker stays inside the remaining workspace and its clipping ancestors ${JSON.stringify(state)}`);
    assert.ok(state.menu.width>0&&state.menu.height>0&&state.scrollWidth<=state.clientWidth+1, `${width}: turn picker has positive bounds without horizontal overflow`);
    assert.ok(state.rows.every(row=>row.visible&&row.rect.height<=state.clientHeight&&row.sequence?.visible&&row.sequence.contained&&row.prompt?.visible&&row.prompt.contained&&row.prompt.width>0&&row.prompt.height>0&&row.prompt.height<=30&&row.prompt.scrollWidth<=row.prompt.clientWidth+1), `${width}: visible turn numbers and bounded prompt previews stay inside every row ${JSON.stringify(state.rows)}`);
    const annotatedRow=state.rows.find(row=>row.id===String(annotatedTurnId));
    assert.ok(annotatedRow?.comments?.visible&&annotatedRow.comments.contained&&annotatedRow.comments.width>0&&annotatedRow.comments.scrollWidth<=annotatedRow.comments.clientWidth+1&&annotatedRow.commentsText==='2 comments'&&annotatedRow.meta?.visible&&annotatedRow.meta.contained&&annotatedRow.meta.width>0, `${width}: real annotation metadata remains visible and bounded ${JSON.stringify(annotatedRow)}`);
    const runningRow=state.rows.at(-1);
    assert.ok(runningRow?.status?.visible&&runningRow.status.contained&&runningRow.status.width>0&&runningRow.status.scrollWidth<=runningRow.status.clientWidth+1&&runningRow.statusText==='Stopping…', `${width}: real Stop lifecycle status fits its turn row ${JSON.stringify(runningRow)}`);
    assert.equal(state.activeId, currentTurnId, `${width}: opening the picker focuses the current turn`);
    assert.ok(['auto','scroll'].includes(state.overflowY)&&state.scrollHeight>state.clientHeight, `${width}: long turn history remains user-scrollable`);
    await capture(`native-${width}-${expanded?'expanded':'collapsed'}-turn-picker`);

    if (width===375&&expanded) {
      await sendNativeInput({type:'keyDown',keyCode:'Escape'});
      await sendNativeInput({type:'keyUp',keyCode:'Escape'});
      await waitFor('Escape closes turn picker and restores trigger focus',()=>evaluate("document.querySelector('#turnPickerButton').getAttribute('aria-expanded')==='false'&&document.activeElement.id==='turnPickerButton'"));
      await pointerClick('#turnPickerButton');
      await waitFor('turn picker reopens for real scroll and selection',()=>evaluate("document.querySelector('#turnPickerButton').getAttribute('aria-expanded')==='true'"),1_500);
      const beforeScroll=await evaluate("document.querySelector('#turnPopover').scrollTop");
      const menuBox=await evaluate("(()=>{const r=document.querySelector('#turnPopover').getBoundingClientRect();return{x:Math.round((r.left+r.right)/2),y:Math.round((r.top+r.bottom)/2)}})()");
      await dispatchBrowserWheel(menuBox,-700);
      await waitFor('turn picker scrolls toward the first turn',()=>evaluate(`document.querySelector('#turnPopover').scrollTop<${beforeScroll}`));
      const first=await evaluate(`(()=>{const menu=document.querySelector('#turnPopover'),row=menu.querySelector('[data-turn-id="${turnIds[0]}"]'),r=row.getBoundingClientRect(),m=menu.getBoundingClientRect();return{scrollTop:menu.scrollTop,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},menu:{left:m.left,right:m.right,top:m.top,bottom:m.bottom}}})()`);
      assert.ok(first.scrollTop<beforeScroll&&first.rect.width>0&&first.rect.height>0&&first.rect.left>=first.menu.left-.5&&first.rect.right<=first.menu.right+.5&&first.rect.top>=first.menu.top-.5&&first.rect.bottom<=first.menu.bottom+.5, `First turn is reachable after browser wheel input ${JSON.stringify(first)}`);
      await capture('native-375-expanded-turn-picker-first');
      const apiBefore=(await fixture.request(`/api/threads/${threadId}`)).interactions.map(item=>String(item.id));
      await pointerClick(`#turnPopover [data-turn-id="${turnIds[0]}"]`);
      await waitFor('exact first turn selected by native pointer',()=>evaluate(`import('./src/state.js').then(m=>String(m.viewState.currentInteractionId)===${JSON.stringify(String(turnIds[0]))})`));
      assert.equal(await evaluate("document.querySelector('#turnPickerButton').getAttribute('aria-expanded')"),'false','Selecting a turn closes the picker');
      assert.deepEqual((await fixture.request(`/api/threads/${threadId}`)).interactions.map(item=>String(item.id)),apiBefore,'Turn selection leaves accepted and pending history unchanged');
      scenarios.push({width,expanded,focus:state.activeId,turnIds:state.rows.map(row=>row.id),comments:annotatedRow.commentsText,status:runningRow.statusText,escapeFocus:true,firstTurnReachable:true,selectedTurnId:String(turnIds[0]),historyUnchanged:true});
    } else if (width===483) {
      await sendNativeInput({type:'keyDown',keyCode:'Escape'});
      await sendNativeInput({type:'keyUp',keyCode:'Escape'});
      await waitFor(`Escape closes turn picker at ${width}px`,()=>evaluate("document.querySelector('#turnPickerButton').getAttribute('aria-expanded')==='false'"));
      await pointerClick('#turnPickerButton');
      await waitFor('turn picker reopens for annotation overlap',()=>evaluate("document.querySelector('#turnPickerButton').getAttribute('aria-expanded')==='true'"));
      // The background root-layer comment badge overlaps Turn 2 at this width.
      // Bounds alone cannot prove the popup wins the actual pointer target.
      const overlap=await evaluate(`(()=>{const badge=document.querySelector('#workspaceBreadcrumb .breadcrumb-annotation-badge'),row=document.querySelector('#turnPopover [data-turn-id="${turnIds[1]}"]'),b=badge.getBoundingClientRect(),r=row.getBoundingClientRect(),x=Math.round((b.left+b.right)/2),y=Math.round((b.top+b.bottom)/2),hit=document.elementFromPoint(x,y);return{x,y,badgeVisible:badge.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),insideRow:x>r.left&&x<r.right&&y>r.top&&y<r.bottom,rowOwnsHit:row===hit||row.contains(hit),hitTag:hit?.tagName,hitClass:hit?.className}})()`);
      assert.ok(overlap.badgeVisible&&overlap.insideRow&&overlap.rowOwnsHit,`Open picker owns the background annotation overlap ${JSON.stringify(overlap)}`);
      await sendNativeInput({type:'mouseMove',x:overlap.x,y:overlap.y});
      await sendNativeInput({type:'mouseDown',x:overlap.x,y:overlap.y,button:'left',clickCount:1});
      await sendNativeInput({type:'mouseUp',x:overlap.x,y:overlap.y,button:'left',clickCount:1});
      await waitFor('overlap click selects exact second turn',()=>evaluate(`import('./src/state.js').then(m=>String(m.viewState.currentInteractionId)===${JSON.stringify(turnIds[1])}&&document.querySelector('#turnPickerButton').getAttribute('aria-expanded')==='false')`));
      const closedBadge=await evaluate(`(()=>{const e=document.querySelector('#workspaceBreadcrumb .breadcrumb-annotation-badge'),r=e.getBoundingClientRect(),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return{visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),enabled:!e.disabled,ownsHit:e===hit||e.contains(hit)}})()`);
      assert.ok(closedBadge.visible&&closedBadge.enabled&&closedBadge.ownsHit,`Layer comments remain reachable after history closes ${JSON.stringify(closedBadge)}`);
      await capture('native-483-layer-comments-after-turn-selection');
      scenarios.push({width,expanded,focus:state.activeId,turnIds:state.rows.map(row=>row.id),comments:annotatedRow.commentsText,status:runningRow.statusText,overlap,selectedTurnId:turnIds[1],closedBadge});
    } else {
      await sendNativeInput({type:'keyDown',keyCode:'Escape'});
      await sendNativeInput({type:'keyUp',keyCode:'Escape'});
      await waitFor(`Escape closes turn picker at ${width}px`,()=>evaluate("document.querySelector('#turnPickerButton').getAttribute('aria-expanded')==='false'"));
      scenarios.push({width,expanded,focus:state.activeId,turnIds:state.rows.map(row=>row.id),comments:annotatedRow.commentsText,status:runningRow.statusText});
    }
  }
  results.push({name:'turn-picker-responsive-layout',scenarios,annotationEnabled:true,preview:'two-line clamped prompt; full history remains selectable'});
  return scenarios;
}

async function auditHistoryKeyboard(turnIds) {
  await resize(375);
  if(await evaluate("document.body.classList.contains('sidebar-collapsed')")) await pointerClick('#collapseSidebar');
  await pointerClick('#turnPickerButton');
  await waitFor('keyboard journey opens on current last turn',()=>evaluate(`document.activeElement?.dataset?.turnId===${JSON.stringify(turnIds.at(-1))}`));
  const focusedRows=[];
  for(let index=turnIds.length-1;index>=0;index--) {
    if(index<turnIds.length-1) {
      await sendNativeInput({type:'keyDown',keyCode:'TAB',modifiers:['shift']});
      await sendNativeInput({type:'keyUp',keyCode:'TAB',modifiers:['shift']});
    }
    await waitFor(`keyboard reaches turn ${turnIds[index]}`,()=>evaluate(`document.activeElement?.dataset?.turnId===${JSON.stringify(turnIds[index])}`));
    const focus=await evaluate("(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),m=document.querySelector('#turnPopover').getBoundingClientRect();return{id:e.dataset.turnId,top:r.top,bottom:r.bottom,left:r.left,right:r.right,menu:{top:m.top,bottom:m.bottom,left:m.left,right:m.right}}})()");
    assert.ok(focus.top>=focus.menu.top-.5&&focus.bottom<=focus.menu.bottom+.5&&focus.left>=focus.menu.left-.5&&focus.right<=focus.menu.right+.5,`Focused turn is visible ${JSON.stringify(focus)}`);
    focusedRows.push(focus.id);
  }
  await sendNativeInput({type:'keyDown',keyCode:'ENTER'});
  await sendNativeInput({type:'char',keyCode:'ENTER'});
  await sendNativeInput({type:'keyUp',keyCode:'ENTER'});
  await waitFor('keyboard selects exact first turn',()=>evaluate(`import('./src/state.js').then(m=>String(m.viewState.currentInteractionId)===${JSON.stringify(turnIds[0])})`));
  assert.equal(await evaluate("document.querySelector('#threadPrompt').value"),'Keep this unsent follow-up while inspecting history','Keyboard history selection retains composer draft');
  await pointerClick('#turnPickerButton');
  await waitFor('picker reopens on first turn',()=>evaluate(`document.activeElement?.dataset?.turnId===${JSON.stringify(turnIds[0])}`));
  for(let index=1;index<turnIds.length;index++) {
    await sendNativeInput({type:'keyDown',keyCode:'TAB'});
    await sendNativeInput({type:'keyUp',keyCode:'TAB'});
    await waitFor(`forward Tab reaches turn ${turnIds[index]}`,()=>evaluate(`document.activeElement?.dataset?.turnId===${JSON.stringify(turnIds[index])}`));
  }
  await sendNativeInput({type:'keyDown',keyCode:'ENTER'});
  await sendNativeInput({type:'char',keyCode:'ENTER'});
  await sendNativeInput({type:'keyUp',keyCode:'ENTER'});
  await waitFor('keyboard returns to exact active turn',()=>evaluate(`import('./src/state.js').then(m=>String(m.viewState.currentInteractionId)===${JSON.stringify(turnIds.at(-1))})`));
  assert.equal(await evaluate("document.querySelector('#threadPrompt').value"),'Keep this unsent follow-up while inspecting history','Returning to active turn retains composer draft');
  await pointerClick('#turnPickerButton');
  await waitFor('picker reopens on active turn',()=>evaluate(`document.activeElement?.dataset?.turnId===${JSON.stringify(turnIds.at(-1))}`));
  results.push({name:'turn-picker-keyboard-draft',keyboardReached:focusedRows,keyboardSelected:[turnIds[0],turnIds.at(-1)],draftRetained:true});
  await sendNativeInput({type:'keyDown',keyCode:'Escape'});
  await sendNativeInput({type:'keyUp',keyCode:'Escape'});
}

async function auditPopulatedSidebar(width, expanded, expectedProjectIds, expectedChatIds) {
  await resize(width);
  const collapsed=await evaluate("document.body.classList.contains('sidebar-collapsed')");
  if(collapsed===expanded) await pointerClick('#collapseSidebar');
  await waitFor(`sidebar ${width}px state`,()=>evaluate(`document.body.classList.contains('sidebar-collapsed')===${!expanded}`));
  const state=await evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})}};const content=document.querySelector('#appSidebarContent'),sidebar=document.querySelector('.sidebar'),footer=document.querySelector('.sidebar-footer'),projects=[...document.querySelectorAll('#projectList [data-project-row]')],chats=[...document.querySelectorAll('#chatList [data-thread]')],f=box(footer),s=box(sidebar),c=box(content);return{sidebar:s,content:c,overflowY:getComputedStyle(content).overflowY,scrollTop:content.scrollTop,scrollHeight:content.scrollHeight,clientHeight:content.clientHeight,footer:f,footerOutside:!content.contains(footer),footerVisible:f.visible&&f.top>=0&&f.bottom<=innerHeight,footerContained:f.left>=s.left-.5&&f.right<=s.right+.5,settings:box(document.querySelector('#settingsButton')),account:box(document.querySelector('#desktopAccountButton')),update:box(document.querySelector('#updateButton')),newThread:box(document.querySelector('#newThread')),projectIds:projects.map(e=>e.dataset.projectRow),chatIds:chats.map(e=>e.dataset.thread),projects:projects.length,chats:chats.length,documentWidth:document.documentElement.scrollWidth}})()`);
  assert.deepEqual([...state.projectIds].sort(),expectedProjectIds,`${width}: all populated project IDs are present exactly once`);
  assert.deepEqual([...state.chatIds].sort(),expectedChatIds,`${width}: all populated chat IDs are present exactly once`);
  assert.ok(['auto','scroll'].includes(state.overflowY)&&state.scrollHeight>state.clientHeight,`${width}: populated sidebar content owns a real scroll range ${JSON.stringify(state)}`);
  assert.ok(state.footerOutside&&state.footerVisible&&state.footerContained,`${width}: footer remains fixed and fully visible outside the scrolling content`);
  assert.ok(state.documentWidth<=width,`${width}: populated navigation creates no horizontal page overflow`);
  assert.ok(state.settings.visible&&state.settings.width>0&&state.settings.height>0&&state.account.visible&&state.account.width>0&&state.account.height>0&&state.update.visible&&state.update.width>0&&state.update.height>0,`${width}: Settings and Account footer controls remain visible`);
  assert.ok([state.settings,state.account,state.update].every(control=>control.left>=state.footer.left-.5&&control.right<=state.footer.right+.5&&control.top>=state.footer.top-.5&&control.bottom<=state.footer.bottom+.5),`${width}: all three footer controls fit their fixed footer ${JSON.stringify(state)}`);
  assert.ok(state.newThread.visible&&state.newThread.width>0&&state.newThread.height>=36,`${width}: New Thread remains a positive-size control`);
  await capture(`native-${width}-${expanded?'expanded':'collapsed'}-populated-sidebar`);
  if(width===960&&expanded) {
    const point=await evaluate(`(()=>{const e=document.querySelector('#appSidebarContent'),r=e.getBoundingClientRect();window.__sidebarWheelReceipt=null;e.addEventListener('wheel',event=>window.__sidebarWheelReceipt={trusted:event.isTrusted,deltaY:event.deltaY,targetInside:event.target.closest('#appSidebarContent')===e},{once:true});return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    const before=await evaluate("document.querySelector('#appSidebarContent').scrollTop");
    await dispatchBrowserWheel(point,500);
    await waitFor('populated sidebar receives trusted wheel and scrolls',()=>evaluate(`Boolean(window.__sidebarWheelReceipt?.trusted&&window.__sidebarWheelReceipt.deltaY>0&&window.__sidebarWheelReceipt.targetInside&&document.querySelector('#appSidebarContent').scrollTop>${before})`));
    state.wheel=await evaluate("({receipt:window.__sidebarWheelReceipt,scrollTop:document.querySelector('#appSidebarContent').scrollTop})");
    assert.ok(state.wheel.scrollTop>before,state.wheel);
  }
  return state;
}

async function auditSidebarKeyboardAndSettings(expectedProjectIds, expectedChatIds, draftThreadId, nestedThreadId, draftTurnId) {
  const scrollPoint=await evaluate("(()=>{const r=document.querySelector('#appSidebarContent').getBoundingClientRect();return{x:Math.round((r.left+r.right)/2),y:Math.round((r.top+r.bottom)/2)}})()");
  await dispatchBrowserWheel(scrollPoint,-2000);
  await waitFor('wheel returns to New Thread',()=>evaluate("document.querySelector('#appSidebarContent').scrollTop===0"));
  await pointerClick('#newThread');
  await waitFor('New Thread starts the native sidebar tab journey',()=>evaluate("import('./src/state.js').then(m=>m.viewState.mainView==='new')"));
  // New Thread activation focuses its composer; seed the tab journey at the
  // already pointer-reached navigation control, then use native keys throughout.
  await evaluate("document.querySelector('#newThread').focus()");
  const targets=await evaluate(`(()=>[...document.querySelectorAll('#appSidebarContent [data-thread],#projectList .project-button,#projectList .project-new-thread')].map(e=>({kind:e.matches('[data-thread]')?'chat':e.matches('.project-button')?'project':'project-action',id:e.dataset.thread||e.closest('[data-project-row]')?.dataset.projectRow||e.dataset.projectNewThread,selector:e.matches('[data-thread]')?'chat':e.matches('.project-button')?'project':'project-action'})))()`);
  assert.deepEqual(targets.filter(item=>item.kind==='chat').map(item=>item.id).sort(),expectedChatIds,'Tab order includes each saved chat');
  assert.deepEqual([...new Set(targets.filter(item=>item.kind!=='chat').map(item=>item.id))].sort(),expectedProjectIds,'Tab order includes each project row');
  assert.equal(targets.filter(item=>item.kind==='project-action').length,expectedProjectIds.length,'Every project exposes its nested New Thread action');
  const threadCountBefore=(await fixture.request('/api/state')).threads.length;
  const contentTop=await evaluate("document.querySelector('#appSidebarContent').scrollTop");
  assert.equal(contentTop,0,'User wheel input restores the first navigation control');
  const reached=[];
  for(const [index,target] of targets.entries()) {
    await sendNativeInput({type:'keyDown',keyCode:'TAB'});
    await sendNativeInput({type:'keyUp',keyCode:'TAB'});
    const expected=JSON.stringify(target);
    await waitFor(`Tab reaches ${target.kind} ${target.id}`,()=>evaluate(`(()=>{const target=${expected},e=document.activeElement;if(target.kind==='chat')return e?.dataset?.thread===target.id;if(target.kind==='project')return e?.matches('.project-button')&&e.closest('[data-project-row]')?.dataset.projectRow===target.id;return e?.dataset?.projectNewThread===target.id})()`));
    await waitFor(`Focused ${target.kind} ${target.id} finishes its reveal`,()=>evaluate("document.activeElement.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&getComputedStyle(document.activeElement).opacity==='1'"),1500);
    const focus=await evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect();let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};for(let p=e.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(['auto','scroll','hidden','clip'].includes(s.overflowX)){clip.left=Math.max(clip.left,b.left+p.clientLeft);clip.right=Math.min(clip.right,b.left+p.clientLeft+p.clientWidth)}if(['auto','scroll','hidden','clip'].includes(s.overflowY)){clip.top=Math.max(clip.top,b.top+p.clientTop);clip.bottom=Math.min(clip.bottom,b.top+p.clientTop+p.clientHeight)}}return{kind:${JSON.stringify(target.kind)},id:${JSON.stringify(target.id)},visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},clip,scrollTop:document.querySelector('#appSidebarContent').scrollTop}})()`);
    assert.ok(focus.visible&&focus.rect.width>0&&focus.rect.height>0&&focus.rect.left>=focus.clip.left-.5&&focus.rect.right<=focus.clip.right+.5&&focus.rect.top>=focus.clip.top-.5&&focus.rect.bottom<=focus.clip.bottom+.5,`Tab target ${target.kind} ${target.id} is visible within the sidebar scroller ${JSON.stringify(focus)}`);
    reached.push({kind:target.kind,id:target.id,scrollTop:focus.scrollTop});
    if(index===targets.length-1) await capture('native-960-last-project-action-focused');
  }
  assert.ok(reached.at(-1).scrollTop>reached[0].scrollTop,'Keyboard traversal scrolls from chats through the final project action');
  await pointerClick(`#projectList [data-thread="${nestedThreadId}"]`);
  await waitFor('nested project chat selects its exact saved thread',()=>evaluate(`import('./src/state.js').then(m=>String(m.viewState.currentThreadId)===${JSON.stringify(String(nestedThreadId))})`));
  const lastProjectId=targets.filter(item=>item.kind==='project').at(-1).id;
  await pointerClick(`#projectList [data-project-new-thread="${lastProjectId}"]`);
  await waitFor('late project action opens its scoped New Thread',()=>evaluate(`import('./src/state.js').then(m=>m.viewState.mainView==='new'&&m.viewState.selectedScope.kind==='project'&&String(m.viewState.selectedScope.projectId)===${JSON.stringify(lastProjectId)})`));
  assert.equal((await fixture.request('/api/state')).threads.length,threadCountBefore,'Project New Thread action does not create a saved thread before Send');
  const settingsBefore=await evaluate("document.querySelector('#settingsButton').getBoundingClientRect().toJSON()");
  assert.ok(settingsBefore.width>0&&settingsBefore.height>0,'Settings footer remains available after sidebar scrolling');
  await pointerClick('#settingsButton');
  await waitFor('Settings opens from fixed footer',()=>evaluate("import('./src/state.js').then(m=>m.viewState.mainView==='settings')"));
  await waitFor('desktop Settings tab receives focus',()=>evaluate("document.activeElement.matches('[data-settings-tab]')"));
  await sendNativeInput({type:'keyDown',keyCode:'TAB',modifiers:['shift']});
  await sendNativeInput({type:'keyUp',keyCode:'TAB',modifiers:['shift']});
  await waitFor('Shift+Tab reaches Settings Back',()=>evaluate("document.activeElement.id==='settingsBackButton'"));
  const back=await evaluate(`(()=>{const e=document.querySelector('#settingsBackButton'),r=e.getBoundingClientRect(),c=document.querySelector('#settingsSidebarContent'),cr=c.getBoundingClientRect(),s=document.querySelector('.sidebar').getBoundingClientRect();return{focused:document.activeElement===e,text:e.innerText,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},content:{left:cr.left,right:cr.right,top:cr.top,bottom:cr.bottom},sidebar:{left:s.left,right:s.right,top:s.top,bottom:s.bottom}}})()`);
  assert.ok(back.focused&&back.text.includes('Back')&&back.rect.width>0&&back.rect.height>0&&back.rect.left>=back.content.left-.5&&back.rect.right<=back.content.right+.5&&back.rect.top>=back.content.top-.5&&back.rect.bottom<=back.content.bottom+.5&&back.rect.left>=back.sidebar.left-.5&&back.rect.right<=back.sidebar.right+.5,'Settings Back remains keyboard reachable and contained in the settings scroller');
  await capture('native-960-settings-back-focused');
  await pointerClick('#settingsBackButton');
  await waitFor('Settings Back returns to New Thread',()=>evaluate("import('./src/state.js').then(m=>m.viewState.mainView==='new')"));
  assert.equal((await fixture.request('/api/state')).threads.length,threadCountBefore,'Navigation and project actions do not create a thread');
  await resize(375);
  await pointerClick('#settingsButton');
  await waitFor('narrow Settings opens from the fixed footer',()=>evaluate("import('./src/state.js').then(m=>m.viewState.mainView==='settings')"));
  for(const tab of ['account','advanced']) {
    await settingsPanel(tab,`native-375-populated-sidebar-${tab}`);
    assert.equal(await evaluate("document.querySelector('#settingsCompactSelect').value"),tab,`375px Settings reaches ${tab} through the compact navigation`);
  }
  await pointerClick('#settingsCompactBackButton');
  await waitFor('narrow Settings Back returns without creating a thread',()=>evaluate("import('./src/state.js').then(m=>m.viewState.mainView==='new')"));
  assert.equal((await fixture.request('/api/state')).threads.length,threadCountBefore,'Narrow Settings navigation creates no saved thread');
  await resize(960);
  const returnScrollPoint=await evaluate("(()=>{const r=document.querySelector('#appSidebarContent').getBoundingClientRect();return{x:Math.round((r.left+r.right)/2),y:Math.round((r.top+r.bottom)/2)}})()");
  await dispatchBrowserWheel(returnScrollPoint,-2000);
  await waitFor('return wheel reaches saved chats',()=>evaluate("document.querySelector('#appSidebarContent').scrollTop===0"));
  await pointerClick(`#chatList [data-thread="${draftThreadId}"]`);
  // loadThread sets the thread ID before its asynchronous refresh hydrates the turn and composer.
  await waitFor('sidebar hydrates the exact original draft turn',()=>evaluate(`import('./src/state.js').then(m=>String(m.viewState.currentThreadId)===${JSON.stringify(String(draftThreadId))}&&String(m.viewState.currentInteractionId)===${JSON.stringify(String(draftTurnId))})`));
  assert.equal(await evaluate("document.querySelector('#threadPrompt').value"),'Keep this unsent follow-up while inspecting history','Sidebar project and Settings journey retains saved follow-up draft');
  results.push({name:'populated-sidebar-keyboard-settings',draftRetained:true,nestedThreadId,reached,settingsFooter:settingsBefore,settingsBack:back,projectActionScopeId:lastProjectId,threadCountBefore});
}
const panels = {
  account: ["#desktopAccountLogout"],
  providers: ["#refreshProviderCatalogs", "#newProviderDefinition", '[data-provider-rename="fixture-openai"]', '[data-provider-remove="fixture-openai"]'],
  models: ["#defaultHarnessSelect", "#defaultProviderSelect", "#previousFamily", ".current-family-button", "#nextFamily", "#newModelFamily"],
  harnesses: [".harness-configuration-card"],
  appearance: ["#appearanceSelect"],
  updates: ["#updateChannel", "#checkUpdates"],
  advanced: ["#startTutorial"],
};
async function settingsPanel(tab, label, familyEditing = false) {
  await evaluate(`(() => {if(innerWidth>760){document.querySelector('[data-settings-tab="${tab}"]').click();return;}const s=document.querySelector('#settingsCompactSelect');s.value=${JSON.stringify(tab)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`Settings ${tab}`, () => evaluate(`!document.querySelector('[data-settings-panel="${tab}"]').classList.contains('hidden')`));
  await settle();
  if (["providers", "models", "harnesses"].includes(tab)) {
    const expected = { providers: ".provider-definition-card", models: ".family-card", harnesses: ".harness-configuration-card" }[tab];
    await waitFor(`populated ${tab}`, () => evaluate(`Boolean(document.querySelector(${JSON.stringify(expected)}))`));
  }
  if(tab==="models") await waitFor("family carousel snapped",()=>evaluate(`(()=>{const c=document.querySelector('#familyCarousel');return c.clientWidth>0&&Math.abs(c.scrollLeft-Math.round(c.scrollLeft/c.clientWidth)*c.clientWidth)<.5;})()`));
  const audit = await evaluate(`(async () => {
    const panel=document.querySelector('[data-settings-panel="${tab}"]');
    const view=document.querySelector('#settingsView');
    view.scrollTop=0;
    const bounds=view.getBoundingClientRect();
    const positive=e=>e?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
    const horizontal=e=>{const r=e.getBoundingClientRect(), b=e.closest('.sidebar')?.getBoundingClientRect()||bounds;return r.left>=b.left-.5&&r.right<=b.right+.5;};
    const carousel=document.querySelector('#familyCarousel');
    const activeSlide=carousel?.children[Math.round(carousel.scrollLeft/carousel.clientWidth)];
    const active=e=>!e.closest('.family-slide')||e.closest('.family-slide')===activeSlide;
    // The existing family carousel intentionally scrolls between whole cards;
    // audit the selected card now, and select every other card through Next below.
    // Text fields and native selects scroll/clip their value inside the control;
    // require the control box to fit, not its unbounded user-entered text.
    const allowsInternalText=e=>e.matches('input,select,textarea')||(e.id==='currentFamilyName'&&getComputedStyle(e).textOverflow==='ellipsis');
    const overflow=[view,panel,...panel.querySelectorAll('*')].filter(positive).filter(active).filter(e=>!horizontal(e)||e.id!=='familyCarousel'&&!allowsInternalText(e)&&e.scrollWidth>e.clientWidth+1 && e.clientWidth>0).map(e=>({tag:e.tagName,id:e.id,class:e.className,scroll:e.scrollWidth,client:e.clientWidth}));
    const navigation=innerWidth<=760?['#settingsCompactBackButton','#settingsCompactSelect']:['#settingsBackButton','[data-settings-tab="${tab}"]'];
    const selectors=[...navigation,...${JSON.stringify(panels[tab])}];
    if(${JSON.stringify(tab)}==='models') {
      if(!activeSlide) throw Error('Missing selected family card');
      const index=Number(activeSlide.dataset.familySlide);
      if(![0,1].includes(index)) throw Error('Unexpected fixture family index');
      if(${JSON.stringify(familyEditing)}) {
        selectors.push('#familyNameInput','[data-member-provider="0"]','[data-member-model="0"]','[data-member-up="0"]','[data-member-down="0"]','[data-member-remove="0"]','#addFamilyModel','#cancelFamilyEdit','#saveFamilyEdit');
      } else {
        const actions=index===0?['enabled','left','right','copy']:['enabled','left','right','edit','delete'];
        for(const action of actions) selectors.push('[data-family-'+action+'="'+index+'"]');
      }
    }
    if(${JSON.stringify(tab)}==='harnesses') {
      const ids=[...panel.querySelectorAll('[data-harness-configuration]')].map(e=>e.dataset.harnessConfiguration).sort();
      if(JSON.stringify(ids)!==JSON.stringify(['fixture-stop-codex','fixture-stop-prime'])) throw Error('Expected both populated fixture harness cards: '+JSON.stringify(ids));
    }
    const controls=[];
    const extraControls=[...panel.querySelectorAll('button,input,select,textarea')].filter(positive).filter(active);
    const expected=selectors.flatMap(selector=>{
      const matches=[...document.querySelectorAll(selector)];
      if(!matches.length) throw Error('Missing expected Settings control '+selector);
      return matches.map(e=>({e,selector}));
    });
    for(const {e,selector} of [...expected,...extraControls.map(e=>({e,selector:e.id||e.getAttribute('aria-label')||e.tagName}))]) {
        e.scrollIntoView({block:'nearest',inline:'nearest'});
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const r=e.getBoundingClientRect();
        controls.push({selector,visible:positive(e),horizontal:horizontal(e),onscreen:r.top>=0&&r.bottom<=innerHeight,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}});
    }
    view.scrollTop=0;
    return {tab:${JSON.stringify(tab)},text:panel.textContent.trim(),overflow,controls};
  })()`);
  assert.ok(audit.text.length > 10, `${tab} populated`);
  assert.deepEqual(audit.overflow, [], `${label}/${tab}: horizontal containment`);
  assert.ok(audit.controls.every(c => c.visible && c.horizontal && c.onscreen), `${label}/${tab}: controls ${JSON.stringify(audit.controls)}`);
  results.push({ name: `${label}-${tab}`, ...audit });
  await capture(`${label}-${tab}`);
}
async function main() {
  await mkdir(evidence, { recursive: true });
  await recordPhase("main:evidence-directory-ready");
  fixture = await stopRunFixture();
  const projectDirectory = join(fixture.directory, 'Project "quoted" & names');
  await mkdir(projectDirectory);
  const project = await fixture.request("/api/projects", { method: "POST", body: JSON.stringify({ path: projectDirectory }) });
  const scopeProjects=[project];
  const thread = await fixture.create("codex", 'accept native "sidebar" evidence');
  await waitFor("accepted graph", async () => (await fixture.request(`/api/threads/${thread.id}`)).interactions[0]?.completionStatus === "accepted");
  window = await createWindowFactory({ BrowserWindow, desktopDirectory: resolve("desktop"), getAppearance: () => appearance, updater: { status: () => ({ phase: "development" }) }, openExternal: async () => { throw new Error("Unexpected external navigation"); }, onWindowCreated: created => {
    window = created;
    // Test scheduling only: keep rendered layout progressing if another macOS
    // window occludes this production-created window. Electron also changes
    // Page Visibility here; this runner does not prove default background behavior.
    window.webContents.setBackgroundThrottling(false);
    assert.equal(window.webContents.getBackgroundThrottling(),false);
    window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
  } })(fixture.session);
  window.show(); window.focus();
  await recordPhase("window:shown-and-focused");
  await waitFor("native shell ready", () => evaluate("document.querySelector('#appShell')?.checkVisibility() && !document.body.classList.contains('desktop-account-pending')"));
  await evaluate("(() => {if(window.__nativeRafHeartbeatStarted)return;window.__nativeRafHeartbeatStarted=true;window.__nativeRafCount=0;const beat=()=>{window.__nativeRafCount++;window.__nativeRafAt=performance.now();requestAnimationFrame(beat);};requestAnimationFrame(beat);})()");
  await recordPhase("window:native-shell-ready");
  await evaluate(`import('./src/threads.js').then(m=>m.loadThread(${thread.id}))`);
  assert.deepEqual(window.getMinimumSize(), [375, 640]);
  const preferences = window.webContents.getLastWebPreferences();
  assert.ok(preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration);
  assert.deepEqual(await evaluate("window.relayerDesktop.account.read()"), account);
  for (const width of [760, 620, 375]) {
    await resize(width);
    await shell(`native-${width}-collapsed`, false);
    await evaluate("document.querySelector('#collapseSidebar').click()");
    await shell(`native-${width}-expanded`, true);
    await resize(width + 1);
    if (width < 760) await shell(`native-${width + 1}-preserved`, true);
    await resize(761);
    await shell(`native-761-after-${width}`, true);
  }
  assert.ok(results.some(r=>r.animationBounds?.length>=5), "At least one live toggle transform animation must be sampled");
  await resize(375);
  await shell("native-375-reentry", false);
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Accessibility.enable");
  const ax = await window.webContents.debugger.sendCommand("Accessibility.getFullAXTree");
  const named = ax.nodes.find(n => !n.ignored && n.role?.value === "button" && n.name?.value === thread.title);
  assert.ok(named, `Collapsed native AX tree must expose thread title ${thread.title}`);
  assert.ok(ax.nodes.some(n => !n.ignored && n.role?.value === "button" && n.name?.value === project.name), "Collapsed project must retain its accessible name");
  await evaluate("document.querySelector('#newThread').click()");
  await waitFor("New Thread before named activation",()=>evaluate("!document.querySelector('#newThreadView').classList.contains('hidden')"));
  await evaluate(`document.querySelector('[data-thread="${thread.id}"]').click()`);
  await waitFor("named chat activation", () => evaluate(`import('./src/state.js').then(m=>m.viewState.mainView==='thread'&&String(m.viewState.currentThreadId)===${JSON.stringify(String(thread.id))})`));
  await writeFile(join(evidence, "accessibility.json"), JSON.stringify(ax, null, 2));
  window.webContents.debugger.detach();
  await evaluate("document.querySelector('#collapseSidebar').click();document.querySelector('#settingsButton').click()");
  for (const tab of Object.keys(panels)) {
    await settingsPanel(tab, "native-375-expanded");
    if(tab==="models") {
      const count=await evaluate("document.querySelector('#familyCarousel').children.length");
      assert.ok(count>=2, "Populated system and custom families required");
      for(let index=1;index<count;index++) {
        await evaluate("document.querySelector('#nextFamily').click()");
        await waitFor("family card selected",()=>evaluate(`Math.abs(document.querySelector('#familyCarousel').scrollLeft-${index}*document.querySelector('#familyCarousel').clientWidth)<1`));
        await settingsPanel(tab, `native-375-family-${index}`);
      }
      await evaluate("document.querySelector('[data-family-edit=\"1\"]').click()");
      await settingsPanel(tab, 'native-375-family-edit', true);
      await evaluate("document.querySelector('#cancelFamilyEdit').click()");
    }
  }
  await settingsPanel("appearance", "native-375-theme");
  await evaluate("document.querySelector('#appearanceSelect').value='light';document.querySelector('#appearanceSelect').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitFor("light theme persisted", () => appearance === "light");
  await capture("native-375-light-appearance");
  await evaluate("document.querySelector('#settingsCompactBackButton').click()");
  assert.equal(await evaluate("document.activeElement.id"), "collapseSidebar");
  await evaluate("document.querySelector('#desktopAccountButton').click()");
  assert.equal(await evaluate("document.querySelector('#settingsCompactSelect').value"), "account");
  await resize(620);
  await evaluate("document.querySelector('#collapseSidebar').click()");
  for (const tab of Object.keys(panels)) await settingsPanel(tab, "native-620-collapsed");
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Accessibility.enable");
  const settingsAx=await window.webContents.debugger.sendCommand("Accessibility.getFullAXTree");
  for(const name of ["Account","Providers","Model families","Harnesses","Appearance","Application updates","Advanced"]) assert.ok(settingsAx.nodes.some(n=>!n.ignored&&n.role?.value==="tab"&&n.name?.value===name), `Collapsed Settings tab named ${name}`);
  await writeFile(join(evidence,"settings-accessibility.json"),JSON.stringify(settingsAx,null,2));
  window.webContents.debugger.detach();
  for (const [width, expanded] of [[375,false],[483,true],[620,true],[1280,true]]) {
    await resize(width);
    const collapsed=await evaluate("document.body.classList.contains('sidebar-collapsed')");
    if(collapsed===expanded) await evaluate("document.querySelector('#collapseSidebar').click()");
    for(const tab of Object.keys(panels)) await settingsPanel(tab, `native-${width}-${expanded?'expanded':'collapsed'}-boundary`);
  }
  await resize(620);
  if(!await evaluate("document.body.classList.contains('sidebar-collapsed')")) await evaluate("document.querySelector('#collapseSidebar').click()");
  await evaluate("document.querySelector('#settingsCompactBackButton').click()");
  const evalName = 'Eval "quoted" & <named>';
  await evaluate(`(async()=>{const {viewState}=await import('./src/state.js');viewState.evalContext={harnessConfigurationName:'native-fixture',cases:[{name:'Case',status:'passed',threads:[{id:${thread.id},name:${JSON.stringify(evalName)}}]}]};(await import('./src/navigation.js')).renderSidebar();})()`);
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Accessibility.enable");
  const evalAx = await window.webContents.debugger.sendCommand("Accessibility.getFullAXTree");
  assert.ok(evalAx.nodes.some(n => !n.ignored && n.role?.value === "button" && n.name?.value === evalName), "Collapsed Eval destinations retain their accessible name");
  await writeFile(join(evidence, "eval-accessibility.json"), JSON.stringify(evalAx, null, 2));
  window.webContents.debugger.detach();
  // Keep the existing sparse-project checkpoints above independent; populate
  // the real project list only for this explicit overflow/reachability audit.
  for(let i=0;i<12;i++) {
    const path=join(fixture.directory,`scope-long-unbroken-${String(i+1).padStart(2,'0')}-${'deep'.repeat(8)}`);
    await mkdir(path,{recursive:true});
    scopeProjects.push(await fixture.request('/api/projects',{method:'POST',body:JSON.stringify({name:`Project ${String(i+1).padStart(2,'0')} with a deliberately long spaced title for menu wrapping`,path})}));
  }
  await evaluate("import('./src/threads.js').then(m=>m.refreshState())");
  await waitFor('populated scope projects reach production renderer',()=>evaluate(`import('./src/state.js').then(m=>m.appState.projects.filter(p=>${JSON.stringify(scopeProjects.map(project=>String(project.id)))}.includes(String(p.id))).length===${scopeProjects.length})`));
  await evaluate("(async()=>{const {viewState}=await import('./src/state.js');viewState.evalContext=null;(await import('./src/navigation.js')).renderSidebar();})()");
  await resize(375);
  if(await evaluate("document.body.classList.contains('sidebar-collapsed')")) await evaluate("document.querySelector('#collapseSidebar').click()");
  await auditNewThreadComposer("native-375-expanded-new-thread",thread.id,scopeProjects);
  await recordPhase('follow-up:563-564-fixtures');
  const nested=await fixture.request('/api/threads',{method:'POST',body:JSON.stringify({projectId:scopeProjects.at(-1).id,initialMessage:'accept nested project navigation',harnessId:'fixture-stop-codex',permissionProfileId:'full',modelSelection:fixture.modelSelection})});
  await waitFor('nested project thread accepted',async()=>(await fixture.request(`/api/threads/${nested.id}`)).interactions[0]?.completionStatus==='accepted');
  const history=await fixture.create('codex','accept responsive history with a long prompt '+ 'unbroken'.repeat(10));
  await waitFor('history first turn accepted',async()=>(await fixture.request(`/api/threads/${history.id}`)).interactions[0]?.completionStatus==='accepted');
  for(let i=1;i<4;i++) {
    await fixture.request(`/api/threads/${history.id}/interactions`,{method:'POST',body:JSON.stringify({text:`accept historical turn ${i} with a deliberately long prompt ${'unbroken'.repeat(10)}`,modelSelection:fixture.modelSelection})});
    await waitFor(`history accepted turn ${i+1}`,async()=>{const turns=(await fixture.request(`/api/threads/${history.id}`)).interactions;return turns.length===i+1&&turns.at(-1).completionStatus==='accepted'});
  }
  await fixture.request(`/api/threads/${history.id}/interactions`,{method:'POST',body:JSON.stringify({text:'Inspect responsive tool work with a long status-bearing prompt '+ 'unbroken'.repeat(10),modelSelection:fixture.modelSelection})});
  const live=await waitFor('history active turn',async()=>{const turn=(await fixture.request(`/api/threads/${history.id}`)).interactions.at(-1);return fixture.controls.has(turn.graphNodeId)&&turn});
  const liveControl=fixture.controls.get(live.graphNodeId);
  await withTimeout(liveControl.started.promise,5000,'Live fixture did not start');
  await recordPhase('follow-up:live-turn-started');
  const annotationToken=randomBytes(32).toString('hex');
  const controlCookie=`${fixture.session.cookie.name}=${fixture.session.cookie.value}`;
  const registration=await fetch(new URL('/api/internal/annotation-sessions',fixture.session.origin),{method:'POST',headers:{Cookie:controlCookie,'Content-Type':'application/json'},body:JSON.stringify({token:annotationToken,threadIds:[history.id],authorId:'fixture:layout',authorDisplayName:'Layout fixture'})});
  assert.equal(registration.status,204,'Real thread-scoped annotation session registered');
  for(let i=1;i<=2;i++) await fixture.request(`/api/threads/${history.id}/annotations`,{method:'POST',headers:{Cookie:`${controlCookie}; relayer_annotation=${annotationToken}`},body:JSON.stringify({anchor:{kind:'turn',interactionId:live.id},comment:`Layout metadata comment ${i}`})});
  await window.webContents.session.cookies.set({url:fixture.session.origin,name:'relayer_annotation',value:annotationToken,httpOnly:true,sameSite:'strict'});
  await resize(960);
  await window.loadURL(fixture.session.origin);
  window.show();window.focus();
  await waitFor('fresh writable annotated shell',()=>evaluate("import('./src/state.js').then(m=>m.appState.capabilities?.annotations===true&&document.querySelector('#appShell').checkVisibility())"));
  await evaluate(`import('./src/threads.js').then(m=>m.loadThread(${history.id}))`);
  await waitFor('live Stop control',()=>evaluate("document.querySelector('#sendInteraction')?.getAttribute('aria-label')==='Stop run'&&!document.querySelector('#sendInteraction').disabled"));
  await pointerClick('#sendInteraction');
  await withTimeout(liveControl.aborted.promise,5000,'Native Stop click did not abort the fixture');
  await recordPhase('follow-up:stop-aborted');
  await waitFor('held Stopping lifecycle',()=>evaluate("document.querySelector('#sendInteraction')?.getAttribute('aria-label')==='Stopping'"));
  const historyBefore=(await fixture.request(`/api/threads/${history.id}`)).interactions.map(({id,completionStatus})=>({id,completionStatus}));
  await auditTurnPickerLayout(history.id,historyBefore.map(turn=>String(turn.id)),live.id);
  assert.deepEqual((await fixture.request(`/api/threads/${history.id}`)).interactions.map(({id,completionStatus})=>({id,completionStatus})),historyBefore,'Pointer and keyboard selection preserve exact history statuses');
  liveControl.settled.resolve();
  await waitFor('history stopped',async()=>(await fixture.request(`/api/threads/${history.id}`)).interactions.at(-1).completionStatus==='stopped');
  await resize(960);
  await evaluate(`import('./src/threads.js').then(m=>m.loadThread(${history.id}))`);
  await waitFor('stopped thread has writable composer',()=>evaluate("!document.querySelector('#threadPrompt').disabled"));
  await pointerClick('#threadPrompt');
  window.webContents.insertText('Keep this unsent follow-up while inspecting history');
  await waitFor('native draft input arrives',()=>evaluate("document.querySelector('#threadPrompt').value==='Keep this unsent follow-up while inspecting history'"));
  const stoppedHistory=(await fixture.request(`/api/threads/${history.id}`)).interactions.map(({id,completionStatus})=>({id,completionStatus}));
  await auditHistoryKeyboard(stoppedHistory.map(turn=>String(turn.id)));
  assert.deepEqual((await fixture.request(`/api/threads/${history.id}`)).interactions.map(({id,completionStatus})=>({id,completionStatus})),stoppedHistory,'Keyboard draft journey leaves stopped and accepted history unchanged');
  window.webContents.send('relayer:update-changed',{phase:'available',channel:'stable',version:'0.0.0-evidence',availableVersion:'0.0.1-evidence'});
  await waitFor('real updater IPC reveals footer indicator',()=>evaluate("document.querySelector('#updateButton').checkVisibility()"));

  await evaluate("import('./src/threads.js').then(m=>m.refreshState())");
  const populated=await fixture.request('/api/state');
  const expectedProjects=populated.projects.map(item=>String(item.id)).sort();
  const expectedChats=populated.threads.filter(item=>!item.projectId).map(item=>String(item.id)).sort();
  const sidebarScenarios=[];
  for(const [width,expanded] of [[375,true],[375,false],[1280,true],[960,true]]) sidebarScenarios.push(await auditPopulatedSidebar(width,expanded,expectedProjects,expectedChats));
  results.push({name:'populated-sidebar-scroll-layout',scenarios:sidebarScenarios});
  await auditSidebarKeyboardAndSettings(expectedProjects,populated.threads.map(item=>String(item.id)).sort(),history.id,nested.id,live.id);
  assert.deepEqual(rendererErrors, [], "No renderer error messages");
  await writeFile(join(evidence, "result.json"), JSON.stringify({ passed: true, platform: process.platform, inference: false, productionWindowFactory: true, scheduling: { backgroundThrottling: window.webContents.getBackgroundThrottling(), pageVisibilityOverride: true, defaultBackgroundBehaviorVerified: false, physicalOsInputVerified: false }, results }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence, scenarios: results.length }));
  exitCode = 0;
}
void app.whenReady().then(main).catch(async error => {
  console.error(error);
  await writeFile(join(evidence, "failure.json"), JSON.stringify({ error: String(error.stack || error), rendererErrors, results }, null, 2)).catch(() => {});
  if (window && !window.isDestroyed()) await capture("failure").catch(() => {});
}).finally(async () => {
  window?.destroy();
  await fixture?.close();
  await rm(profile, { recursive: true, force: true });
  app.exit(exitCode);
});
