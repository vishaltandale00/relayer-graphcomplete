'use strict';

const { unlinkSync } = require('node:fs');
const { generateKeyPairSync, sign } = require('node:crypto');
const { serialize } = require('node:v8');
const net = require('node:net');
const path = require('node:path');

const workspace = process.argv[2];
if (!workspace) throw new Error('Usage: node deterministic-socket-race.cjs <candidate-workspace>');
const lowLevelSend = process._send?.bind(process);
if (!lowLevelSend) throw new Error('The sealed driver requires an evaluator-owned IPC channel.');
const createObject = Object.create.bind(Object);
const createNullObject = () => createObject(null);
const bufferToString = Buffer.prototype.toString;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
lowLevelSend({
  kind: 'driver-signing-key',
  publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
});
const sendReceipt = (message) => {
  const payloadBytes = serialize(message);
  const payload = bufferToString.call(payloadBytes, 'base64');
  const signature = bufferToString.call(sign(null, payloadBytes, privateKey), 'base64');
  const envelope = createNullObject();
  envelope.kind = 'signed-driver-payload';
  envelope.payload = payload;
  envelope.signature = signature;
  lowLevelSend(envelope);
};
Object.defineProperty(process, 'send', { value: undefined, configurable: false, writable: false });
Object.defineProperty(process, '_send', { value: undefined, configurable: false, writable: false });
Object.defineProperty(process, 'channel', { value: undefined, configurable: false, writable: false });
unlinkSync(__filename);

const originalCreateConnection = net.createConnection;

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function nextTurn() {
  return new Promise((resolve) => process.nextTick(resolve));
}

function withDeadline(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 1_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function installFaultPlan(plan) {
  let connection = 0;
  const failures = [];
  net.createConnection = function evaluatorCreateConnection(...args) {
    const socket = originalCreateConnection.apply(net, args);
    connection += 1;
    const connectionNumber = connection;
    const originalWrite = socket.write;
    socket.write = function evaluatorWrite(data, ...writeArgs) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const fault = plan.find((entry) => !entry.used
        && entry.connection === connectionNumber
        && text.includes(`\r\n${entry.command.toLowerCase()}\r\n`));
      if (!fault) return originalWrite.call(socket, data, ...writeArgs);
      fault.used = true;
      const error = Object.assign(new Error(`evaluator injected ${fault.code}`), { code: fault.code });
      failures.push({ connection: connectionNumber, command: fault.command, code: fault.code });
      socket.emit('error', error);
      socket.destroy();
      return false;
    };
    return socket;
  };
  return { failures, get connectionCount() { return connection; } };
}

function callbackCommand(client, command, args, events, label) {
  return new Promise((resolve) => {
    client.send_command(command, args, (error, reply) => {
      const event = {
        label,
        errorCode: error?.code ?? null,
        reply: Buffer.isBuffer(reply) ? reply.toString('utf8') : reply ?? null,
      };
      events.push(event);
      resolve(event);
    });
  });
}

async function endClient(client) {
  client.end(true);
  await immediate();
}

async function runSingleFailure(redis, port) {
  const plan = [{ connection: 1, command: 'set', code: 'EPIPE', used: false }];
  const control = installFaultPlan(plan);
  const events = [];
  const queueLengths = [];
  const client = redis.createClient(port, '127.0.0.1', {
    no_ready_check: true,
    retry_strategy: () => 1,
  });
  client.on('error', () => {});
  let readyCount = 0;
  let poisoned;
  let offlinePing;
  let postReconnectPing;
  let queueAfterFault;
  const scenario = new Promise((resolve) => {
    client.on('ready', async () => {
      readyCount += 1;
      queueLengths.push(client.command_queue_length);
      if (readyCount === 1) {
        poisoned = callbackCommand(client, 'set', ['poisoned', 'value'], events, 'poisoned-set');
        await nextTurn();
        queueAfterFault = client.command_queue_length;
        offlinePing = callbackCommand(client, 'ping', [], events, 'offline-ping');
      } else if (readyCount === 2) {
        postReconnectPing = callbackCommand(client, 'ping', [], events, 'post-reconnect-ping');
        Promise.all([poisoned, offlinePing, postReconnectPing]).then(resolve);
      }
    });
  });
  let timedOut = false;
  try {
    await withDeadline(scenario, 'single-failure scenario');
  } catch {
    timedOut = true;
  }
  await immediate();
  const queueAfterReplies = client.command_queue_length;
  await endClient(client);
  return { control, events, queueLengths, queueAfterFault, queueAfterReplies, timedOut };
}

async function runRepeatedFailure(redis, port) {
  const plan = [
    { connection: 1, command: 'set', code: 'EPIPE', used: false },
    { connection: 2, command: 'get', code: 'ECONNRESET', used: false },
  ];
  const control = installFaultPlan(plan);
  const events = [];
  const queueLengths = [];
  const failedCommands = [];
  const queueAfterFaults = [];
  let offlinePing;
  const client = redis.createClient(port, '127.0.0.1', {
    no_ready_check: true,
    retry_strategy: () => 1,
  });
  client.on('error', () => {});
  let readyCount = 0;
  const scenario = new Promise((resolve) => {
    client.on('ready', async () => {
      readyCount += 1;
      queueLengths.push(client.command_queue_length);
      if (readyCount <= 2) {
        failedCommands.push(callbackCommand(
          client,
          readyCount === 1 ? 'set' : 'get',
          readyCount === 1 ? ['failed-1', 'value-1'] : ['failed-2'],
          events,
          `failed-command-${readyCount}`,
        ));
        await nextTurn();
        queueAfterFaults.push(client.command_queue_length);
        if (readyCount === 2) offlinePing = callbackCommand(client, 'ping', [], events, 'offline-ping-after-fault');
        return;
      }
      try {
        const commands = [
          offlinePing,
          callbackCommand(client, 'set', ['alpha', 'A'], events, 'set-alpha'),
          callbackCommand(client, 'set', ['beta', 'B'], events, 'set-beta'),
          callbackCommand(client, 'get', ['alpha'], events, 'get-alpha'),
          callbackCommand(client, 'get', ['beta'], events, 'get-beta'),
          callbackCommand(client, 'ping', [], events, 'final-ping'),
        ];
        await Promise.all(commands);
        resolve();
      } catch (error) {
        resolve(error);
      }
    });
  });
  let timedOut = false;
  try {
    await withDeadline(scenario, 'repeated-failure scenario');
  } catch {
    timedOut = true;
  }
  await immediate();
  const queueAfterReplies = client.command_queue_length;
  await endClient(client);
  return { control, events, queueLengths, queueAfterFaults, queueAfterReplies, timedOut };
}

async function runReplyModeControls(redis, port) {
  installFaultPlan([]);
  const events = [];
  const client = redis.createClient(port, '127.0.0.1', { no_ready_check: true });
  client.on('error', () => {});
  const scenario = new Promise((resolve) => {
    client.once('ready', async () => {
      await callbackCommand(client, 'client', ['reply', 'skip'], events, 'reply-skip');
      await callbackCommand(client, 'set', ['skip-key', 'skip-value'], events, 'skipped-set');
      await callbackCommand(client, 'get', ['skip-key'], events, 'get-after-skip');
      await callbackCommand(client, 'client', ['reply', 'off'], events, 'reply-off');
      await callbackCommand(client, 'set', ['off-key', 'off-value'], events, 'off-set');
      await callbackCommand(client, 'client', ['reply', 'on'], events, 'reply-on');
      await callbackCommand(client, 'get', ['off-key'], events, 'get-after-on');
      resolve();
    });
  });
  let timedOut = false;
  try {
    await withDeadline(scenario, 'reply-mode control scenario');
  } catch {
    timedOut = true;
  }
  await immediate();
  const queueAfterReplies = client.command_queue_length;
  await endClient(client);
  return { events, queueAfterReplies, timedOut };
}

async function main() {
  const port = Number(process.argv[3]);
  if (!Number.isInteger(port) || port <= 0) throw new Error('The sealed driver requires an evaluator-owned loopback port.');
  try {
    const redis = require(path.resolve(workspace));
    const single = await runSingleFailure(redis, port);
    delete require.cache[require.resolve(path.resolve(workspace))];
    const repeated = await runRepeatedFailure(redis, port);
    const replyModes = await runReplyModeControls(redis, port);
    sendReceipt({
      kind: 'candidate-observations',
      single: { ...single, control: { failures: single.control.failures, connectionCount: single.control.connectionCount } },
      repeated: { ...repeated, control: { failures: repeated.control.failures, connectionCount: repeated.control.connectionCount } },
      replyModes,
    });
  } catch (error) {
    sendReceipt({ kind: 'candidate-infrastructure-error', detail: error?.stack || String(error) });
    process.exitCode = 1;
  } finally {
    net.createConnection = originalCreateConnection;
  }
}

main();
