'use strict';

const { fork } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workspace = process.argv[2];
if (!workspace) throw new Error('Usage: node deterministic-socket-race.cjs <candidate-workspace>');

const privateDirectory = mkdtempSync(path.join(os.tmpdir(), 'node-redis-sealed-worker-'));
const privateEvaluator = path.join(privateDirectory, 'evaluator.cjs');
const privateDriver = path.join(privateDirectory, 'driver.cjs');
writeFileSync(privateEvaluator, readFileSync(path.join(__dirname, 'deterministic-socket-race-evaluator.cjs')), { mode: 0o500 });
writeFileSync(privateDriver, readFileSync(path.join(__dirname, 'deterministic-socket-race-driver.cjs')), { mode: 0o500 });
const child = fork(privateEvaluator, [path.resolve(workspace), privateDriver], {
  cwd: path.resolve(workspace),
  env: {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '/private/tmp',
    LANG: 'C',
    LC_ALL: 'C',
  },
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
});

let receipt;
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000); });
child.on('message', (message) => {
  if (receipt !== undefined) return;
  if (message && message.schemaVersion === 1 && Array.isArray(message.predicates)) receipt = message;
});
child.once('error', (error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  rmSync(privateDirectory, { recursive: true, force: true });
  if (!receipt) {
    process.stderr.write(`${stderr || `sealed worker exited ${code ?? signal} without a receipt`}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = code === 0 && receipt.predicates.every(({ passed }) => passed) ? 0 : 1;
});
