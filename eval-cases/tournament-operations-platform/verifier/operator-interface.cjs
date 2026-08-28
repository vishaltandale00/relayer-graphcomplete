const { app, BrowserWindow } = require("electron");

const htmlPath = process.argv.at(-1);
if (!htmlPath) process.exit(2);

app.commandLine.appendSwitch("disable-gpu");
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await window.loadFile(htmlPath);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement) || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        for (let current = element; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (current.hidden || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return element.getClientRects().length > 0;
      };
      const problems = [];
      for (const name of ['registration', 'schedule', 'standings', 'bracket', 'conflicts']) {
        const element = document.querySelector('[data-tournament-view="' + name + '"]');
        if (!visible(element) || !element.textContent.trim()) problems.push('visible-view:' + name);
      }
      const seam = await import('./src/index.js');
      const targets = {
        'record-result': { exportName: 'recordResult', views: ['standings', 'bracket'] },
        withdraw: { exportName: 'withdrawTeam', views: ['registration'] },
        reschedule: { exportName: 'rescheduleMatch', views: ['schedule', 'conflicts'] },
      };
      for (const [hook, { exportName, views }] of Object.entries(targets)) {
        const control = document.querySelector('[data-tournament-action="' + hook + '"]');
        if (!visible(control) || control.disabled) { problems.push('enabled-action:' + hook); continue; }
        const before = views.map((view) => document.querySelector('[data-tournament-view="' + view + '"]')?.textContent ?? '');
        const receiptPromise = new Promise((resolve) => document.addEventListener('tournament-operation', (event) => resolve(event.detail), { once: true }));
        control.click();
        const receipt = await Promise.race([receiptPromise, new Promise((resolve) => setTimeout(() => resolve(null), 500))]);
        const after = views.map((view) => document.querySelector('[data-tournament-view="' + view + '"]')?.textContent ?? '');
        if (!receipt || receipt.action !== exportName || receipt.implementation !== seam[exportName] || !Array.isArray(receipt.args)) {
          problems.push('public-seam-action:' + hook);
          continue;
        }
        let expected;
        try { expected = seam[exportName](...structuredClone(receipt.args)); }
        catch { problems.push('replayable-action:' + hook); continue; }
        if (JSON.stringify(expected) !== JSON.stringify(receipt.output)) problems.push('operation-output:' + hook);
        if (hook === 'reschedule') {
          const event = receipt.args[1];
          const beforeMatch = receipt.args[0]?.matches?.find((match) => match.id === event?.matchId);
          const afterMatch = receipt.output?.matches?.find((match) => match.id === event?.matchId);
          const beforeSlot = beforeMatch?.schedule;
          const afterSlot = afterMatch?.schedule;
          if (!beforeMatch || !afterMatch || beforeMatch.id !== afterMatch.id || !afterSlot || receipt.output?.scheduleFeasibility?.feasible !== true
            || (beforeSlot?.venueId === afterSlot.venueId && beforeSlot?.court === afterSlot.court && beforeSlot?.start === afterSlot.start)
            || afterSlot.venueId !== event.venueId || afterSlot.court !== event.court || afterSlot.start !== event.start) {
            problems.push('moved-feasible-match:' + hook);
          }
        }
        if (after.every((value, index) => value === before[index]) || !after.some((value) => value.includes(JSON.stringify(receipt.output)))) problems.push('rendered-output:' + hook);
      }
      return { passed: problems.length === 0, problems };
    })()`);
    process.stdout.write(`RELAYER_UI_RESULT ${JSON.stringify(result)}\n`);
    await window.close();
    await app.quit();
    process.exit(result.passed ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    await window.close();
    await app.quit();
    process.exit(1);
  }
});
