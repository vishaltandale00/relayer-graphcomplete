'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..');
const originalCreateConnection = net.createConnection;

function nextTurn() {
  return new Promise((resolve) => process.nextTick(resolve));
}

function command(client, name, args) {
  return new Promise((resolve) => client.send_command(name, args, (error, reply) => resolve({
    error,
    reply: Buffer.isBuffer(reply) ? reply.toString('utf8') : reply,
  })));
}

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

async function main() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const state = { buffer: Buffer.alloc(0) };
    socket.on('data', (bytes) => {
      for (const [name = ''] of parseCommands(state, bytes)) {
        if (name.toUpperCase() === 'PING') socket.write('+PONG\r\n');
        else if (name.toUpperCase() === 'SET') socket.write('+OK\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  let connection = 0;
  let injected = false;
  net.createConnection = function createConnection(...args) {
    const socket = originalCreateConnection.apply(net, args);
    connection += 1;
    const originalWrite = socket.write;
    socket.write = function write(data, ...writeArgs) {
      const source = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      if (!injected && connection === 1 && source.includes('\r\nset\r\n')) {
        injected = true;
        socket.emit('error', Object.assign(new Error('candidate regression fault'), { code: 'EPIPE' }));
        socket.destroy();
        return false;
      }
      return originalWrite.call(socket, data, ...writeArgs);
    };
    return socket;
  };

  const redis = require(workspace);
  const client = redis.createClient(server.address().port, '127.0.0.1', {
    no_ready_check: true,
    retry_strategy: () => 1,
  });
  client.on('error', () => {});
  let ready = 0;
  let failed;
  let offline;
  const complete = new Promise((resolve) => {
    client.on('ready', async () => {
      ready += 1;
      if (ready === 1) {
        failed = command(client, 'set', ['race-key', 'race-value']);
        await nextTurn();
        assert.equal(client.command_queue_length, 0, 'faulted command must leave no stale reply slot');
        offline = command(client, 'ping', []);
      } else if (ready === 2) {
        resolve(Promise.all([failed, offline, command(client, 'ping', [])]));
      }
    });
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('regression scenario did not settle')), 1_000));
  const [failure, queuedPing, livePing] = await Promise.race([complete, timeout]);
  assert.ok(failure.error, 'faulted command callback must receive an error');
  assert.equal(failure.reply, undefined);
  assert.deepEqual([queuedPing.reply, livePing.reply], ['PONG', 'PONG']);
  assert.equal(client.command_queue_length, 0);

  client.end(true);
  net.createConnection = originalCreateConnection;
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}

main().catch((error) => {
  net.createConnection = originalCreateConnection;
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
