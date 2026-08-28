'use strict';

const { fork } = require('node:child_process');
const { createPublicKey, verify } = require('node:crypto');
const { deserialize } = require('node:v8');
const { unlinkSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const workspace = path.resolve(process.argv[2] || '');
const driver = path.resolve(process.argv[3] || '');
const sendReceipt = process.send?.bind(process);
if (!workspace || !driver || !sendReceipt) throw new Error('The sealed evaluator requires workspace, driver, and controller IPC.');
Object.defineProperty(process, 'send', { value: undefined, configurable: false, writable: false });
unlinkSync(__filename);

const predicateIds = [
  'fault-injection-observed',
  'failed-command-rejected-once',
  'queue-clean-before-reconnect',
  'reconnect-reply-order',
  'offline-queue-replayed-in-order',
  'reconnect-queue-drained',
  'single-failure-callbacks-settle',
  'repeated-faults-observed',
  'fault-command-matrix-observed',
  'repeated-failures-rejected-independently',
  'repeated-reconnects-start-clean',
  'ordered-replies-after-recovery',
  'no-command-reply-misassociation',
  'callbacks-settle-without-hang',
  'client-reply-modes-preserved',
];

function parseCommands(state, chunk) {
  state.buffer = Buffer.concat([state.buffer, Buffer.from(chunk)]);
  const commands = [];
  while (state.buffer.length > 0) {
    const source = state.buffer.toString('utf8');
    const firstEnd = source.indexOf('\r\n');
    if (firstEnd < 0 || source[0] !== '*') break;
    const count = Number(source.slice(1, firstEnd));
    let offset = firstEnd + 2;
    const parts = [];
    let complete = true;
    for (let index = 0; index < count; index += 1) {
      const lengthEnd = source.indexOf('\r\n', offset);
      if (lengthEnd < 0 || source[offset] !== '$') { complete = false; break; }
      const length = Number(source.slice(offset + 1, lengthEnd));
      const valueStart = lengthEnd + 2;
      const valueEnd = valueStart + length;
      if (source.length < valueEnd + 2) { complete = false; break; }
      parts.push(source.slice(valueStart, valueEnd));
      offset = valueEnd + 2;
    }
    if (!complete) break;
    commands.push(parts);
    state.buffer = state.buffer.subarray(Buffer.byteLength(source.slice(0, offset)));
  }
  return commands;
}

function encodeBulk(value) {
  if (value === undefined) return '$-1\r\n';
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function createServer(transcript) {
  const values = new Map();
  const sockets = new Set();
  let connection = 0;
  const server = net.createServer((socket) => {
    connection += 1;
    const connectionNumber = connection;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const state = { buffer: Buffer.alloc(0), replyMode: 'ON', skipNext: false };
    socket.on('data', (chunk) => {
      for (const parts of parseCommands(state, chunk)) {
        transcript.push({ connection: connectionNumber, parts });
        const [rawCommand = '', ...args] = parts;
        const command = rawCommand.toUpperCase();
        if (command === 'CLIENT' && args[0]?.toUpperCase() === 'REPLY') {
          const mode = args[1]?.toUpperCase();
          if (mode === 'OFF') state.replyMode = 'OFF';
          else if (mode === 'ON') { state.replyMode = 'ON'; socket.write('+OK\r\n'); }
          else if (mode === 'SKIP') state.skipNext = true;
          continue;
        }
        const suppressReply = state.replyMode === 'OFF' || state.skipNext;
        state.skipNext = false;
        if (command === 'SET') {
          values.set(args[0], args[1]);
          if (!suppressReply) socket.write('+OK\r\n');
        } else if (command === 'GET') {
          if (!suppressReply) socket.write(encodeBulk(values.get(args[0])));
        } else if (command === 'PING') {
          if (!suppressReply) socket.write('+PONG\r\n');
        } else if (command === 'QUIT') socket.end('+OK\r\n');
        else socket.write('-ERR unsupported evaluator command\r\n');
      }
    });
  });
  server.evaluatorSockets = sockets;
  return server;
}

function record(target, id, passed, detail) {
  target.push({ id, passed: Boolean(passed), detail });
}

function grade(raw, transcript) {
  const observations = [];
  const { single, repeated, replyModes } = raw;
  const rejectedKeysReachedServer = transcript.some(({ parts }) => ['poisoned', 'failed-1', 'failed-2'].includes(parts[1]));
  const commandsByConnection = new Map();
  for (const { connection, parts } of transcript) {
    const commands = commandsByConnection.get(connection) || [];
    commands.push(parts);
    commandsByConnection.set(connection, commands);
  }
  const connectionSequences = [...commandsByConnection.values()];
  const containsSequence = (expected) => connectionSequences.some((commands) => JSON.stringify(commands) === JSON.stringify(expected));
  const singleTranscriptObserved = containsSequence([['ping'], ['ping']]);
  const repeatedTranscriptObserved = containsSequence([['ping'], ['set', 'alpha', 'A'], ['set', 'beta', 'B'], ['get', 'alpha'], ['get', 'beta'], ['ping']]);
  const replyModeTranscriptObserved = containsSequence([['client', 'reply', 'skip'], ['set', 'skip-key', 'skip-value'], ['get', 'skip-key'], ['client', 'reply', 'off'], ['set', 'off-key', 'off-value'], ['client', 'reply', 'on'], ['get', 'off-key']]);
  record(observations, 'fault-injection-observed', single.control.failures.length === 1 && !rejectedKeysReachedServer && singleTranscriptObserved, JSON.stringify({ failures: single.control.failures, rejectedKeysReachedServer, singleTranscriptObserved }));
  const poisonedEvents = single.events.filter((event) => event.label === 'poisoned-set');
  record(observations, 'failed-command-rejected-once', poisonedEvents.length === 1 && poisonedEvents[0].errorCode !== null && poisonedEvents[0].reply === null, JSON.stringify(poisonedEvents));
  record(observations, 'queue-clean-before-reconnect', single.queueAfterFault === 0, JSON.stringify({ queueAfterFault: single.queueAfterFault, readyQueueLengths: single.queueLengths }));
  const singlePings = single.events.filter((event) => event.label.includes('ping'));
  record(observations, 'reconnect-reply-order', singlePings.length === 2 && singlePings.every((event) => event.errorCode === null && event.reply === 'PONG'), JSON.stringify(single.events));
  record(observations, 'offline-queue-replayed-in-order', JSON.stringify(singlePings.map(({ label, errorCode, reply }) => [label, errorCode, reply])) === JSON.stringify([['offline-ping', null, 'PONG'], ['post-reconnect-ping', null, 'PONG']]), JSON.stringify(singlePings));
  record(observations, 'reconnect-queue-drained', single.queueAfterReplies === 0, `command_queue_length=${single.queueAfterReplies}`);
  record(observations, 'single-failure-callbacks-settle', single.timedOut === false, single.timedOut ? 'The reconnect command sequence did not settle.' : 'Every callback settled inside the event-driven deadline.');
  record(observations, 'repeated-faults-observed', repeated.control.failures.length === 2 && !rejectedKeysReachedServer && repeatedTranscriptObserved, JSON.stringify({ failures: repeated.control.failures, rejectedKeysReachedServer, repeatedTranscriptObserved }));
  record(observations, 'fault-command-matrix-observed', JSON.stringify(repeated.control.failures.map(({ command, code }) => [command, code])) === JSON.stringify([['set', 'EPIPE'], ['get', 'ECONNRESET']]), JSON.stringify(repeated.control.failures));
  const repeatedFailures = repeated.events.filter((event) => event.label.startsWith('failed-command-'));
  record(observations, 'repeated-failures-rejected-independently', repeatedFailures.length === 2 && repeatedFailures.every((event) => event.errorCode !== null && event.reply === null), JSON.stringify(repeatedFailures));
  record(observations, 'repeated-reconnects-start-clean', repeated.queueAfterFaults.length === 2 && repeated.queueAfterFaults.every((length) => length === 0), JSON.stringify({ queueAfterFaults: repeated.queueAfterFaults, readyQueueLengths: repeated.queueLengths }));
  const successful = repeated.events.filter((event) => !event.label.startsWith('failed-command-'));
  record(observations, 'ordered-replies-after-recovery', JSON.stringify(successful.map(({ label, errorCode, reply }) => [label, errorCode, reply])) === JSON.stringify([['offline-ping-after-fault', null, 'PONG'], ['set-alpha', null, 'OK'], ['set-beta', null, 'OK'], ['get-alpha', null, 'A'], ['get-beta', null, 'B'], ['final-ping', null, 'PONG']]), JSON.stringify(successful));
  record(observations, 'no-command-reply-misassociation', repeatedTranscriptObserved && repeated.events.every((event) => (event.label.startsWith('failed-command-') ? event.errorCode !== null && event.reply === null : event.errorCode === null)) && repeated.queueAfterReplies === 0, JSON.stringify({ events: repeated.events, queueAfterReplies: repeated.queueAfterReplies, repeatedTranscriptObserved }));
  record(observations, 'callbacks-settle-without-hang', repeated.timedOut === false, repeated.timedOut ? 'The repeated-failure command sequence did not settle.' : 'Every callback settled inside the event-driven deadline.');
  record(observations, 'client-reply-modes-preserved', replyModeTranscriptObserved && replyModes.timedOut === false && replyModes.queueAfterReplies === 0 && JSON.stringify(replyModes.events.map(({ label, errorCode, reply }) => [label, errorCode, reply])) === JSON.stringify([['reply-skip', null, null], ['skipped-set', null, null], ['get-after-skip', null, 'skip-value'], ['reply-off', null, null], ['off-set', null, null], ['reply-on', null, 'OK'], ['get-after-on', null, 'off-value']]), JSON.stringify({ ...replyModes, replyModeTranscriptObserved }));
  return observations;
}

async function main() {
  const transcript = [];
  const server = createServer(transcript);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const child = fork(driver, [workspace, String(server.address().port)], {
    cwd: workspace,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/private/tmp', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let raw;
  let driverPublicKey;
  let errorDetail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errorDetail = `${errorDetail}${chunk}`.slice(-32_000); });
  child.on('message', (message) => {
    if (message?.kind === 'driver-signing-key' && driverPublicKey === undefined && typeof message.publicKey === 'string') {
      driverPublicKey = createPublicKey(message.publicKey);
      return;
    }
    if (raw !== undefined || message?.kind !== 'signed-driver-payload' || !driverPublicKey
      || typeof message.payload !== 'string' || typeof message.signature !== 'string') return;
    const payload = Buffer.from(message.payload, 'base64');
    if (!verify(null, payload, driverPublicKey, Buffer.from(message.signature, 'base64'))) return;
    const signed = deserialize(payload);
    if (signed?.kind === 'candidate-observations') raw = signed;
    else if (signed?.kind === 'candidate-infrastructure-error') errorDetail = signed.detail;
  });
  const exit = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, detail: error.stack || String(error) }));
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, detail: signal ? `stopped by ${signal}` : '' }));
  });
  for (const socket of server.evaluatorSockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  const predicates = raw && exit.code === 0
    ? grade(raw, transcript)
    : predicateIds.map((id) => ({ id, passed: false, detail: errorDetail || exit.detail || 'Candidate driver emitted no observations.' }));
  sendReceipt({ schemaVersion: 1, predicates });
  process.exitCode = predicates.every(({ passed }) => passed) ? 0 : 1;
}

main().catch((error) => {
  sendReceipt({ schemaVersion: 1, predicates: predicateIds.map((id) => ({ id, passed: false, detail: error.stack || String(error) })) });
  process.exitCode = 1;
});
