import { Buffer } from "node:buffer";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  boundedKernelEnvironmentForSecurityProbe,
  createPrimeWorkspaceBoundary,
  PRIME_PYTHON_SANDBOX_PROBE_BOOTSTRAP,
  primeSeatbeltProfileForSecurityProbe,
  validateInitialJupyterConnectionForSecurityProbe,
} from "../src/implementations/prime-agent-workspace-boundary.js";

const pythonExecutable = process.platform === "darwin"
  ? execFileSync("/usr/bin/which", ["python3"], { encoding: "utf8" }).trim()
  : "/usr/bin/python3";
const graphClientRoot = join(process.cwd(), "python", "relayer-graph", "src");

describe("Prime Agent workspace boundary", () => {
  it.runIf(process.platform === "darwin")("admits only the exact managed launch shape and enforces the seatbelt workspace boundary", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "relayer-prime-boundary-")));
    const lease = await createPrimeWorkspaceBoundary(workspace, graphClientRoot)({ cwd: workspace, signal: new AbortController().signal });
    try {
      expect(() => lease.launch({ command: "/bin/sh", args: ["-c", "true"], cwd: workspace, env: process.env }), "non-Python launch command").toThrow("exact Python executable");
      expect(() => lease.launch({ command: pythonExecutable, args: ["-c", "print('not a kernel')"], cwd: workspace, env: process.env }), "non-kernel Python invocation").toThrow("canonical ipykernel_launcher invocation");
    } finally {
      await lease.dispose("test-completed");
      await rm(workspace, { recursive: true, force: true });
    }

    const sandboxWorkspace = await realpath(await mkdtemp(join(tmpdir(), "relayer prime \"strict-")));
    const runtime = await realpath(await mkdtemp(join(tmpdir(), "relayer-prime-runtime-")));
    const connectionDirectory = await realpath(await mkdtemp(join(tmpdir(), "prime-agent-kernel-")));
    const connectionPath = join(connectionDirectory, "connection.json");
    const unresolvedConnection = {
      transport: "tcp", ip: "127.0.0.1", signature_scheme: "hmac-sha256", key: "test-hmac-key",
      shell_port: 0, iopub_port: 0, stdin_port: 0, control_port: 0, hb_port: 0,
    };
    await writeFile(connectionPath, JSON.stringify(unresolvedConnection), { mode: 0o600 });
    await mkdir(join(runtime, "tmp"), { recursive: true });
    const inside = join(sandboxWorkspace, "inside.json");
    const sibling = join(dirname(sandboxWorkspace), `relayer-prime-sibling-${randomUUID()}`);
    const socketPath = `/tmp/relayer-prime-${process.pid}-${randomUUID()}.sock`;
    const unixServer = createServer();
    await new Promise<void>((resolve, reject) => { unixServer.once("error", reject); unixServer.listen(socketPath, resolve); });

    const program = [
      "import json, os, pathlib, socket, subprocess, sys, threading",
      `sys.path.insert(0, ${JSON.stringify(graphClientRoot)})`,
      "import relayer_graph",
      `inside = pathlib.Path(${JSON.stringify(inside)})`,
      `sibling = pathlib.Path(${JSON.stringify(sibling)})`,
      "result = {}",
      `connection_path = pathlib.Path(${JSON.stringify(connectionPath)})`,
      "connection = json.loads(connection_path.read_text())",
      "result['initial_ports'] = [connection[name] for name in ('shell_port', 'iopub_port', 'stdin_port', 'control_port', 'hb_port')]",
      "for offset, name in enumerate(('shell_port', 'iopub_port', 'stdin_port', 'control_port', 'hb_port')):",
      "    connection[name] = 43101 + offset",
      "connection_path.write_text(json.dumps(connection))",
      "try:", "    sibling.write_text('denied')", "    result['sibling_write'] = 'allowed'",
      "except OSError:", "    result['sibling_write'] = 'denied'",
      "try:",
      "    first = os.fork()",
      "    if first == 0:",
      "        os.setsid()",
      "        second = os.fork()",
      "        os._exit(0 if second >= 0 else 2)",
      "    os.waitpid(first, 0)",
      "    result['double_fork'] = 'allowed'",
      "except OSError:", "    result['double_fork'] = 'denied'",
      "try:", "    subprocess.run(['/usr/bin/true'], check=True)", "    result['exec'] = 'allowed'",
      "except OSError:", "    result['exec'] = 'denied'",
      "client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
      "try:", `    client.connect(${JSON.stringify(socketPath)})`, "    result['unix'] = 'allowed'",
      "except OSError:", "    result['unix'] = 'denied'", "finally:", "    client.close()",
      "server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
      "server.bind(('127.0.0.1', 0)); server.listen(1)",
      "thread = threading.Thread(target=lambda: server.accept()[0].sendall(b'jupyter')); thread.start()",
      "tcp = socket.create_connection(('127.0.0.1', server.getsockname()[1]))",
      "result['loopback'] = tcp.recv(7).decode(); tcp.close(); thread.join(); server.close()",
      "result['secret'] = os.environ.get('AWS_ACCESS_KEY_ID', '')",
      "result['graph_client'] = relayer_graph.__name__",
      "inside.write_text(json.dumps(result, sort_keys=True))",
    ].join("\n");
    const profile = primeSeatbeltProfileForSecurityProbe(sandboxWorkspace, runtime, graphClientRoot, connectionDirectory);
    const child = spawn(pythonExecutable, [
      "-I", "-c", PRIME_PYTHON_SANDBOX_PROBE_BOOTSTRAP,
      Buffer.from(profile, "utf8").toString("base64"), Buffer.from(program, "utf8").toString("base64"),
    ], {
      cwd: sandboxWorkspace,
      env: boundedKernelEnvironmentForSecurityProbe({ ...process.env, AWS_ACCESS_KEY_ID: "must-not-enter" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      expect(await close(child), "sandbox probe exit").toBe(0);
      await expect(readFile(inside, "utf8").then((value) => JSON.parse(value)), "sandboxed behavior matrix").resolves.toEqual({
        double_fork: "denied", exec: "denied", graph_client: "relayer_graph", initial_ports: [0, 0, 0, 0, 0], loopback: "jupyter", secret: "", sibling_write: "denied", unix: "denied",
      });
      const resolved = JSON.parse(await readFile(connectionPath, "utf8"));
      expect(resolved, "connection ports resolved inside the sandbox").toMatchObject({
        shell_port: 43101, iopub_port: 43102, stdin_port: 43103, control_port: 43104, hb_port: 43105,
      });
      await expect(access(sibling), "sibling file never created").rejects.toThrow();
      expect(profile, "job creation denial").toContain("(deny job-creation)");
      expect(profile, "apple event denial").toContain("(deny appleevent-send)");
      expect(profile, "mach lookup denial").toContain("(deny mach-lookup)");
      expect(profile, "mach register denial").toContain("(deny mach-register)");
    } finally {
      await new Promise<void>((resolve) => unixServer.close(() => resolve()));
      await rm(socketPath, { force: true });
      await rm(sibling, { force: true });
      await rm(sandboxWorkspace, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
      await rm(connectionDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("strips ambient credentials from the bounded kernel environment and admits only Prime-owned connection files", async () => {
    const environment = boundedKernelEnvironmentForSecurityProbe({
      PATH: "/usr/bin", HOME: "/safe/home", RLM_DEPTH: "1",
      PYTHONPATH: "/host/injection", DYLD_INSERT_LIBRARIES: "/host/injection.dylib",
      RELAYER_TEST_SECRET: "secret", AWS_ACCESS_KEY_ID: "secret", AWS_PROFILE: "secret",
      GOOGLE_APPLICATION_CREDENTIALS: "secret", GITHUB_PAT: "secret", DATABASE_URL: "secret",
    });
    expect(environment, "minimal environment without injection or credential variables").toEqual({ PATH: "/usr/bin", HOME: "/safe/home", RLM_DEPTH: "1" });

    const workspace = await realpath(await mkdtemp(join(tmpdir(), "relayer-prime-workspace-")));
    const directory = await realpath(await mkdtemp(join(tmpdir(), "prime-agent-kernel-")));
    const path = join(directory, "connection.json");
    const valid = {
      transport: "tcp", ip: "127.0.0.1", signature_scheme: "hmac-sha256", key: "test-hmac-key",
      shell_port: 0, iopub_port: 0, stdin_port: 0, control_port: 0, hb_port: 0,
    };
    try {
      await writeFile(path, JSON.stringify(valid), { mode: 0o600 });
      expect(validateInitialJupyterConnectionForSecurityProbe(path, workspace), "Prime-owned unresolved connection file").toEqual({ path, directory });
      await writeFile(path, JSON.stringify({ ...valid, ip: "203.0.113.10" }));
      expect(() => validateInitialJupyterConnectionForSecurityProbe(path, workspace), "non-loopback ip").toThrow("unresolved authenticated loopback TCP channels");
      await writeFile(path, JSON.stringify({ ...valid, hb_port: 43105 }));
      expect(() => validateInitialJupyterConnectionForSecurityProbe(path, workspace), "resolved port").toThrow("unresolved authenticated loopback TCP channels");
      await writeFile(path, JSON.stringify({ ...valid, key: "" }));
      expect(() => validateInitialJupyterConnectionForSecurityProbe(path, workspace), "missing hmac key").toThrow("unresolved authenticated loopback TCP channels");
      await writeFile(path, "not-json");
      expect(() => validateInitialJupyterConnectionForSecurityProbe(path, workspace), "invalid JSON").toThrow("not valid JSON");
      await writeFile(path, JSON.stringify(valid));
      await chmod(path, 0o644);
      expect(() => validateInitialJupyterConnectionForSecurityProbe(path, workspace), "world-readable file").toThrow("owner-private");

      const symlinkDirectory = await realpath(await mkdtemp(join(tmpdir(), "prime-agent-kernel-")));
      const symlinkPath = join(symlinkDirectory, "connection.json");
      await symlink(path, symlinkPath);
      expect(() => validateInitialJupyterConnectionForSecurityProbe(symlinkPath, workspace), "symlinked connection file").toThrow("canonical regular file");
      await rm(symlinkDirectory, { recursive: true, force: true });

      const workspaceRuntime = join(workspace, "prime-agent-kernel-inside");
      await mkdir(workspaceRuntime, { mode: 0o700 });
      const workspaceConnection = join(workspaceRuntime, "connection.json");
      await writeFile(workspaceConnection, JSON.stringify(valid), { mode: 0o600 });
      expect(() => validateInitialJupyterConnectionForSecurityProbe(workspaceConnection, workspace), "workspace-resident runtime directory").toThrow("private non-workspace Prime runtime");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function close(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(code) : reject(new Error(`probe exited ${String(code)}: ${stderr}`)));
  });
}
