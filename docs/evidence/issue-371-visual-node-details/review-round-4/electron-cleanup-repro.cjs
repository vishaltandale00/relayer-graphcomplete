const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
if (process.env.KEEP_CLEANUP_ALIVE === '1') app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
 const window = new BrowserWindow({ show: false });
 window.destroy();
 await new Promise(resolve => setTimeout(resolve, 100));
 await fs.writeFile(process.env.CLEANUP_RESULT, 'cleanup complete');
 app.exit(0);
});
