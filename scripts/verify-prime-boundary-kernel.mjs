import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPrimeWorkspaceBoundary } from "../packages/harness-host/dist/implementations/prime-agent-workspace-boundary.js";

const python = process.env.RELAYER_TEST_PRIME_PYTHON;
if (!python) throw new Error("RELAYER_TEST_PRIME_PYTHON must name an ipykernel-enabled managed interpreter");

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const graphClientRoot = join(repositoryRoot, "python", "relayer-graph", "src");
const workspace = await realpath(await mkdtemp(join(tmpdir(), "relayer-prime-live-workspace-")));
const connectionDirectory = await realpath(await mkdtemp(join(tmpdir(), "prime-agent-kernel-")));
const connectionPath = join(connectionDirectory, "connection.json");
await writeFile(connectionPath, JSON.stringify({
  ip: "127.0.0.1",
  transport: "tcp",
  shell_port: 0,
  iopub_port: 0,
  stdin_port: 0,
  control_port: 0,
  hb_port: 0,
  signature_scheme: "hmac-sha256",
  key: "relayer-boundary-live-proof",
  kernel_name: "python3",
}, null, 2), { mode: 0o600 });

const lease = await createPrimeWorkspaceBoundary(workspace, graphClientRoot)({
  cwd: workspace,
  signal: new AbortController().signal,
});
try {
  const kernel = lease.launch({
    command: python,
    args: ["-m", "ipykernel_launcher", "-f", connectionPath],
    cwd: workspace,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
  });
  kernel.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  const clientProgram = [
    "import json, pathlib, sys, time",
    "from jupyter_client import BlockingKernelClient",
    "connection_path = pathlib.Path(sys.argv[1])",
    "deadline = time.monotonic() + 20",
    "while time.monotonic() < deadline:",
    "    connection = json.loads(connection_path.read_text())",
    "    if all(isinstance(connection[name], int) and connection[name] > 0 for name in ('shell_port', 'iopub_port', 'stdin_port', 'control_port', 'hb_port')):",
    "        break",
    "    time.sleep(0.05)",
    "else:",
    "    raise RuntimeError('kernel did not publish resolved ports')",
    "client = BlockingKernelClient(connection_file=sys.argv[1])",
    "client.load_connection_file()",
    "client.start_channels()",
    "client.wait_for_ready(timeout=20)",
    "message_id = client.execute(\"print('boundary-execute-ok')\\n21 * 2\")",
    "observed = []",
    "while True:",
    "    message = client.get_iopub_msg(timeout=20)",
    "    if message.get('parent_header', {}).get('msg_id') != message_id:",
    "        continue",
    "    kind = message.get('msg_type')",
    "    if kind == 'stream': observed.append(message['content']['text'].strip())",
    "    if kind == 'execute_result': observed.append(message['content']['data']['text/plain'])",
    "    if kind == 'status' and message['content'].get('execution_state') == 'idle': break",
    "client.stop_channels()",
    "print(json.dumps({'kernel_info': 'ready', 'execute': observed, 'connection_file': sys.argv[1]}))",
  ].join("\n");
  const proof = await capture(python, ["-I", "-c", clientProgram, connectionPath]);
  const parsed = JSON.parse(proof);
  if (parsed.kernel_info !== "ready"
    || !parsed.execute.includes("boundary-execute-ok")
    || !parsed.execute.includes("42")
    || parsed.connection_file !== connectionPath) {
    throw new Error(`Unexpected bounded kernel proof: ${proof}`);
  }
  console.log(JSON.stringify(parsed));
} finally {
  await lease.dispose("live-proof-completed");
  await rm(workspace, { recursive: true, force: true });
  await rm(connectionDirectory, { recursive: true, force: true });
}

function capture(command, args) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveOutput(stdout.trim());
      else reject(new Error(`Kernel client exited ${String(code)}: ${stderr}`));
    });
  });
}
