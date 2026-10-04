import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

// Layout-only proof: real shell markup, styles, sidebar projection and toggle.
// No app server, account services, inference, or user data are involved.
const root = resolve("desktop/renderer");
const evidence = resolve(process.env.RELAYER_SIDEBAR_EVIDENCE_DIR || ".relayer/evidence/sidebar-overflow");
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, "http://localhost").pathname}`);
    if (!path.startsWith(root + sep)) throw new Error("Invalid path");
    let content = await readFile(path);
    if (path.endsWith("index.html")) content = content.toString().replace('<script type="module" src="./src/main.js"></script>', "");
    response.setHeader("Content-Type", ({ ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" })[extname(path)] || "application/octet-stream");
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
async function main() {
  const timeout = setTimeout(() => { console.error("Sidebar layout proof timed out"); app.exit(1); }, 30000);
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  await app.whenReady();
  await mkdir(evidence, { recursive: true });
  const window = new BrowserWindow({ width: 1100, height: 640, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const results = [];
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}/index.html`);
    await evaluate(`(async () => {
      const { appState, viewState } = await import('./src/state.js');
      const { renderSidebar, setMainView } = await import('./src/navigation.js');
      const { initializeSidebar } = await import('./src/sidebar.js');
      window.sidebarFixture = { appState, viewState, renderSidebar, setMainView };
      initializeSidebar({ body: document.body, toggle: document.querySelector('#collapseSidebar'), mediaQuery: matchMedia('(max-width: 760px)') });
      document.body.classList.remove('desktop-account-pending');
      document.querySelector('.app-shell').classList.remove('hidden');
      document.querySelector('#desktopAccountButton').classList.remove('hidden');
      document.querySelector('#desktopAccountLabel').textContent = 'Account';
      appState.projects = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: 'relayer-graphcomplete-' + i + '-long-project-name' }));
      appState.threads = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: 'A long standalone chat title ' + i }));
      appState.threads[1].activity = 'running';
      for (const project of appState.projects) for (let i = 0; i < 4; i++) appState.threads.push({ id: appState.threads.length + 1, projectId: project.id, title: 'Can you explain the project thread ' + i });
      renderSidebar();
    })()`);
    // ARC-003 visibility and ARC-002 disabled presentation use the real CSS and
    // production sidebar projection, including selected, project and busy chats.
    window.webContents.debugger.attach('1.3');
    try {
      await evaluate("sidebarFixture.viewState.currentThreadId=1; sidebarFixture.renderSidebar();");
      const move = (x, y) => window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      const archiveState = (id) => evaluate(`(() => {
        const button=document.querySelector('[data-archive-thread="${id}"]'),row=button.parentElement,r=button.getBoundingClientRect();
        const style=getComputedStyle(button);
        return {opacity:Number(style.opacity),pointerEvents:style.pointerEvents,disabled:button.disabled,title:button.title,x:r.x,width:r.width,rowWidth:row.getBoundingClientRect().width,hit:button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),hitTag:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,160)};
      })()`);
      for (const id of [1, 13, 2]) {
        await move(1000, 20);
        await evaluate("document.activeElement.blur();");
        const resting=await archiveState(id);
        assert.equal(resting.opacity, 0, `chat ${id}: trashcan hidden at rest`);
        assert.equal(resting.pointerEvents, 'none', `chat ${id}: hidden trashcan cannot receive pointer input`);
        assert.equal(resting.hit, false);
        if (id === 1) await writeFile(resolve(evidence, 'archive-resting.png'), (await window.webContents.capturePage()).toPNG());
        const point=await evaluate(`(() => {const row=document.querySelector('[data-archive-thread="${id}"]').parentElement;row.scrollIntoView({block:'center'});const r=row.querySelector('.entry').getBoundingClientRect();return {x:r.x+12,y:r.y+r.height/2};})()`);
        await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        // Let macOS overlay scrollbars fade before checking the rightmost hit target.
        await new Promise(done=>setTimeout(done,1200));
        await move(point.x, point.y);
        await evaluate("new Promise(resolve=>requestAnimationFrame(resolve))");
        const hovered=await archiveState(id);
        assert.equal(hovered.opacity, id === 2 ? .4 : 1, `chat ${id}: reveal on row hover`);
        assert.equal(hovered.pointerEvents, 'auto');
        assert.equal(hovered.hit, true, `chat ${id}: hovered pointer target ${JSON.stringify(hovered)}`);
        assert.equal(hovered.x, resting.x, 'reveal does not move the control');
        assert.equal(hovered.rowWidth, resting.rowWidth, 'reveal does not resize the row');
        assert.equal(hovered.disabled, id === 2);
        if (id === 2) assert.equal(hovered.title, 'Available when work finishes.');
        assert.equal((await archiveState(id === 1 ? 2 : 1)).opacity, 0, 'neighboring rows stay hidden');
        if (id === 1) await writeFile(resolve(evidence, 'archive-hovered.png'), (await window.webContents.capturePage()).toPNG());
        for (const type of ['mousePressed','mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type,...point,button:'left',clickCount:1});
        await move(1000, 20);
        assert.equal((await archiveState(id)).opacity, 0, 'pointer focus does not leave the control visible');
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
        await evaluate(`document.querySelector('[data-thread="${id}"]').focus();`);
        assert.equal((await archiveState(id)).opacity, id === 2 ? .4 : 1, 'row keyboard focus reveals the control');
        if (id !== 2) {
          await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
          await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
          assert.equal(await evaluate(`document.activeElement.matches('[data-archive-thread="${id}"]')`), true, 'Tab reaches Archive');
          assert.equal((await archiveState(id)).opacity, 1);
        }
        results.push({name:`archive-visibility-${id}`,resting,hovered});
      }
      await evaluate("document.activeElement.blur(); document.querySelector('#appSidebarContent').scrollTop=0;");
      console.log('PASS archive visibility: resting, hovered, keyboard focus, selected, project and busy rows');
    } finally { window.webContents.debugger.detach(); }
    for (const width of [1100, 761, 375]) {
      window.setContentSize(width, 640);
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      for (const collapsed of [false, true]) {
        await evaluate(`if(document.body.classList.contains('sidebar-collapsed') !== ${collapsed}) document.querySelector('#collapseSidebar').click(); document.querySelector('#appSidebarContent').scrollTop = 0;`);
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        const state = await evaluate(`(() => {
          const content = document.querySelector('#appSidebarContent'), footer = document.querySelector('.sidebar-footer');
          const chats = document.querySelector('#chatList'), projects = document.querySelector('#projectList');
          const box = e => { const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height}; };
          const footerHit = [...footer.querySelectorAll('button')].filter(e=>e.checkVisibility()).every(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));});
          return { content:box(content), footer:box(footer), chats:box(chats), projects:box(projects), scrollHeight:content.scrollHeight, clientHeight:content.clientHeight, overflow:getComputedStyle(content).overflowY, footerHit, pageWidth:document.documentElement.scrollWidth, width:innerWidth };
        })()`);
        const name = `${width}-${collapsed ? 'collapsed' : 'expanded'}`;
        if (collapsed) assert.equal(await evaluate("[...document.querySelectorAll('.thread-archive-button')].every(button=>getComputedStyle(button).display==='none')"), true, `${name}: archive controls stay hidden in the rail`);
        await new Promise(done => setTimeout(done, 180)); // Finish the sidebar icon transition before capture.
        await writeFile(resolve(evidence, `${name}.png`), (await window.webContents.capturePage()).toPNG());
        results.push({ name, ...state });
        assert.ok(state.content.height > 0 && state.footer.height > 0, `${name}: shell is visible`);
        assert.ok(state.footerHit, `${name}: footer buttons must receive pointer input`);
        assert.ok(state.content.bottom <= state.footer.top + 1, `${name}: content stays above footer`);
        assert.ok(['auto', 'scroll'].includes(state.overflow), `${name}: populated sidebar must scroll, got ${state.overflow}`);
        assert.ok(state.projects.top >= state.chats.bottom, `${name}: Projects must follow Chats without overlapping`);
        assert.equal(state.pageWidth, state.width, `${name}: no page overflow`);
        let wheelScrollTop;
        window.webContents.debugger.attach('1.3');
        try {
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round((state.content.left+state.content.right)/2), y: Math.round((state.content.top+state.content.bottom)/2), deltaX: 0, deltaY: 250 });
          for (let attempt=0; attempt<30; attempt++) {
            if (await evaluate("document.querySelector('#appSidebarContent').scrollTop > 0")) break;
            await new Promise(done => setTimeout(done, 10));
          }
          wheelScrollTop=await evaluate("document.querySelector('#appSidebarContent').scrollTop");
          assert.ok(wheelScrollTop > 0, `${name}: browser wheel scrolls the list`);
        } finally { window.webContents.debugger.detach(); }
        const reach = await evaluate(`(() => {
          const target = document.querySelector(${JSON.stringify(collapsed ? '.project-list > div:last-child .project-button' : '.project-list > div:last-child .thread-entry-row:last-child .entry')});
          target.focus();
          const r=target.getBoundingClientRect(), c=document.querySelector('#appSidebarContent').getBoundingClientRect();
          const marker=target.querySelector('i')?.getBoundingClientRect();
          return { markerCentered:!marker || Math.abs((marker.left+marker.right-r.left-r.right)/2)<1, height:r.height, rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}, hitTag:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML.slice(0,140), visible:r.top>=c.top && r.bottom<=c.bottom && r.left>=c.left && r.right<=c.right, hit:target.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)), scrollTop:document.querySelector('#appSidebarContent').scrollTop };
        })()`);
        assert.ok(reach.visible && reach.hit && reach.scrollTop > 0, `${name}: focus reaches the last row: ${JSON.stringify(reach)}`);
        if (collapsed) assert.ok(reach.markerCentered && reach.height >= 35, `${name}: project marker is centered in a usable rail button`);
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        await writeFile(resolve(evidence, `${name}-last-row.png`), (await window.webContents.capturePage()).toPNG());
        Object.assign(results[results.length-1], { reach, wheelScrollTop });
        console.log(`PASS ${name}: list scroll, section order, footer hit targets, last-row focus`);
      }
    }
    // Shared layout also hosts Settings and Eval navigation.
    await evaluate("sidebarFixture.setMainView('settings');");
    const settings = await evaluate(`(() => {
      const content=document.querySelector('#settingsSidebarContent'), footer=document.querySelector('.sidebar-footer');
      return { count:content.querySelectorAll('[role=tab]').length, bottom:content.getBoundingClientRect().bottom, footerTop:footer.getBoundingClientRect().top, back:document.querySelector('#settingsBackButton').checkVisibility() };
    })()`);
    assert.equal(settings.count, 8);
    assert.ok(settings.back && settings.bottom <= settings.footerTop);
    await evaluate(`(() => {
      sidebarFixture.setMainView('new');
      sidebarFixture.viewState.evalContext={harnessConfigurationName:'fixture',cases:Array.from({length:30},(_,i)=>({name:'Case '+i,status:'passed',threads:[{id:i+1,name:'Named Eval destination '+i}]}))};
      sidebarFixture.renderSidebar();
      document.querySelector('#chatList .eval-case:last-child button').focus();
    })()`);
    const evalState=await evaluate(`(() => {
      const target=document.querySelector('#chatList .eval-case:last-child button'),r=target.getBoundingClientRect(),c=document.querySelector('#appSidebarContent').getBoundingClientRect();
      return { visible:r.top>=c.top&&r.bottom<=c.bottom, name:target.getAttribute('aria-label'), hit:target.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)) };
    })()`);
    assert.ok(evalState.visible && evalState.hit);
    assert.equal(evalState.name, 'Named Eval destination 29');
    results.push({ name:'settings-and-eval', settings, evalState });
    console.log('PASS populated sidebar layout, Settings and Eval');
  } finally {
    await writeFile(resolve(evidence, "results.json"), JSON.stringify(results, null, 2));
    clearTimeout(timeout);
    window.destroy();
    await new Promise((done) => server.close(done));
    app.quit();
  }

}
main().catch(error => { console.error(error); app.exit(1); });
