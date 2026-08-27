import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface PrimeWorkspaceBoundaryPrepareRequest {
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface PrimeWorkspaceKernelLaunchRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdio?: unknown;
}

export interface PrimeWorkspaceBoundaryLease {
  launch(request: PrimeWorkspaceKernelLaunchRequest): ChildProcess;
  dispose(reason: string): Promise<void>;
}

/**
 * Creates a real macOS Seatbelt boundary for one in-process Prime kernel.
 * Other platforms fail closed until an equivalent launcher is implemented.
 */
export function createPrimeWorkspaceBoundary(workspaceRoot: string, graphClientRoot = process.env.RELAYER_PRIME_PYTHON_CLIENT_ROOT): (
  request: PrimeWorkspaceBoundaryPrepareRequest,
) => Promise<PrimeWorkspaceBoundaryLease> {
  return async (request) => {
    request.signal.throwIfAborted();
    if (process.platform !== "darwin") {
      throw new Error("Prime workspace-write permission profiles require a supported process boundary");
    }
    const canonicalRoot = await realpath(workspaceRoot);
    if (graphClientRoot === undefined) {
      throw new Error("Prime bounded profiles require the host-owned Relayer Python client root");
    }
    const canonicalGraphClientRoot = await realpath(graphClientRoot);
    const graphClientPackage = join(canonicalGraphClientRoot, "relayer_graph", "__init__.py");
    if (!statSync(graphClientPackage).isFile()) {
      throw new Error("Prime bounded profiles require a valid Relayer Python client root");
    }
    const canonicalCwd = await realpath(request.cwd);
    if (!isWithin(canonicalRoot, canonicalCwd)) {
      throw new Error("Prime kernel working directory is outside its admitted workspace boundary");
    }

    const runtimeRoot = await realpath(await mkdtemp(join(tmpdir(), "relayer-prime-boundary-")));
    await Promise.all([
      mkdir(join(runtimeRoot, "tmp"), { recursive: true, mode: 0o700 }),
      mkdir(join(runtimeRoot, "jupyter"), { recursive: true, mode: 0o700 }),
      mkdir(join(runtimeRoot, "ipython"), { recursive: true, mode: 0o700 }),
      mkdir(join(runtimeRoot, "pycache"), { recursive: true, mode: 0o700 }),
    ]);
    const probeProfile = seatbeltProfile();
    const children = new Set<ChildProcess>();
    let disposed = false;

    const launchProbe = (
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ): ChildProcess => spawn("/usr/bin/sandbox-exec", [
      "-D", `RELAYER_WORKSPACE=${canonicalRoot}`,
      "-D", `RELAYER_RUNTIME=${runtimeRoot}`,
      "-p", probeProfile,
      command,
      ...args,
    ], options);

    const allowedProbe = join(canonicalRoot, `.relayer-boundary-allowed-${randomUUID()}`);
    const deniedProbe = join(dirname(canonicalRoot), `.relayer-boundary-denied-${randomUUID()}`);
    try {
      await expectExit(launchProbe("/usr/bin/touch", [allowedProbe], { stdio: "ignore" }), 0, request.signal);
      await expectDenied(launchProbe("/usr/bin/touch", [deniedProbe], { stdio: "ignore" }), deniedProbe, request.signal);
    } catch (error) {
      await Promise.allSettled([rm(runtimeRoot, { recursive: true, force: true })]);
      throw new Error("Prime workspace-write boundary attestation failed", { cause: error });
    } finally {
      await Promise.allSettled([
        rm(allowedProbe, { force: true }),
        rm(deniedProbe, { force: true }),
      ]);
    }

    return Object.freeze({
      launch(launchRequest: PrimeWorkspaceKernelLaunchRequest): ChildProcess {
        if (disposed) throw new Error("Prime workspace-write boundary lease is disposed");
        const launchCwd = realpathSync(resolve(launchRequest.cwd ?? canonicalCwd));
        if (!isWithin(canonicalRoot, launchCwd)) {
          throw new Error("Prime kernel launch cwd is outside its admitted workspace boundary");
        }
        const pythonCommand = validateKernelLaunch(launchRequest, canonicalRoot);
        const connection = validateInitialJupyterConnectionForSecurityProbe(
          launchRequest.args[3]!,
          canonicalRoot,
        );
        const profile = seatbeltProfile(
          canonicalRoot,
          runtimeRoot,
          canonicalGraphClientRoot,
          connection.directory,
        );
        const child = spawn(pythonCommand, [
          "-I",
          "-c",
          PYTHON_SANDBOX_BOOTSTRAP,
          Buffer.from(profile, "utf8").toString("base64"),
          connection.path,
          canonicalGraphClientRoot,
        ], {
          cwd: launchCwd,
          env: {
            ...boundedKernelEnvironment(launchRequest.env),
            TMPDIR: join(runtimeRoot, "tmp"),
            JUPYTER_RUNTIME_DIR: join(runtimeRoot, "jupyter"),
            PYTHONPYCACHEPREFIX: join(runtimeRoot, "pycache"),
            PYTHONDONTWRITEBYTECODE: "1",
            IPYTHONDIR: join(runtimeRoot, "ipython"),
          },
          stdio: launchRequest.stdio as SpawnOptions["stdio"] ?? ["ignore", "pipe", "pipe"],
          detached: true,
        });
        children.add(child);
        child.once("close", () => children.delete(child));
        return child;
      },
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        for (const child of children) terminateProcessTree(child);
        const outcomes = await Promise.allSettled([...children].map(waitForClose));
        await rm(runtimeRoot, { recursive: true, force: true });
        const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
        if (failures.length > 0) throw new AggregateError(failures, "Prime workspace boundary cleanup failed");
      },
    });
  };
}

export function boundedKernelEnvironmentForSecurityProbe(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const allowed = new Set([
    "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL",
    "RLM_DEPTH", "RLM_MAX_DEPTH", "RLM_GLOBAL_HARNESS_STATE_DIR",
    "RLM_SESSION_DIR", "RLM_HARNESS_STATE_DIR", "PRIME_AGENT_CODING_AGENT_DIR",
    "JPY_PARENT_PID",
  ]);
  const sensitive = /(?:^|_)(?:api_?key|auth|cookie|credential|password|secret|token)(?:_|$)|^(?:AWS_ACCESS_KEY_ID|AWS_PROFILE|GOOGLE_APPLICATION_CREDENTIALS|GITHUB_PAT|DATABASE_URL)$/i;
  return Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key) && !sensitive.test(key)));
}

const boundedKernelEnvironment = boundedKernelEnvironmentForSecurityProbe;

export function primeSeatbeltProfileForSecurityProbe(
  workspaceRoot?: string,
  runtimeRoot?: string,
  graphClientRoot?: string,
  connectionDirectory?: string,
): string {
  const workspace = workspaceRoot === undefined ? "(param \"RELAYER_WORKSPACE\")" : JSON.stringify(workspaceRoot);
  const runtime = runtimeRoot === undefined ? "(param \"RELAYER_RUNTIME\")" : JSON.stringify(runtimeRoot);
  return [
    "(version 1)",
    "(allow default)",
    // A bounded kernel cannot escape terminal cleanup by daemonizing, submit
    // launchd work, reach host control sockets, or use macOS IPC side channels.
    // Loopback TCP remains available for the Jupyter connection channels.
    "(deny process-fork)",
    ...(workspaceRoot === undefined ? [] : ["(deny process-exec)"]),
    "(deny job-creation)",
    "(deny network-outbound (remote unix-socket))",
    "(deny appleevent-send)",
    "(deny mach-lookup)",
    "(deny mach-register)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${workspace}))`,
    `(allow file-write* (subpath ${runtime}))`,
    ...(connectionDirectory === undefined ? [] : [`(allow file-write* (subpath ${JSON.stringify(connectionDirectory)}))`]),
    ...(graphClientRoot === undefined ? [] : [`(deny file-write* (subpath ${JSON.stringify(graphClientRoot)}))`]),
    "(allow file-write-data (literal \"/dev/null\"))",
  ].join("\n");
}

const seatbeltProfile = primeSeatbeltProfileForSecurityProbe;

const PYTHON_SANDBOX_BOOTSTRAP = [
  "import base64, ctypes, runpy, sys",
  "profile = base64.b64decode(sys.argv[1])",
  "connection = sys.argv[2]",
  "graph_client_root = sys.argv[3]",
  "lib = ctypes.CDLL('/usr/lib/libsandbox.1.dylib')",
  "error = ctypes.c_char_p()",
  "lib.sandbox_init.argtypes = [ctypes.c_char_p, ctypes.c_uint64, ctypes.POINTER(ctypes.c_char_p)]",
  "lib.sandbox_init.restype = ctypes.c_int",
  "if lib.sandbox_init(profile, 0, ctypes.byref(error)) != 0:",
  "    message = error.value.decode('utf-8', 'replace') if error.value else 'unknown sandbox error'",
  "    raise RuntimeError('sandbox_init failed: ' + message)",
  "sys.path.insert(0, graph_client_root)",
  "import relayer_graph",
  "sys.argv = ['ipykernel_launcher', '-f', connection]",
  "runpy.run_module('ipykernel_launcher', run_name='__main__', alter_sys=True)",
].join("\n");

export const PRIME_PYTHON_SANDBOX_PROBE_BOOTSTRAP = [
  "import base64, ctypes, sys",
  "profile = base64.b64decode(sys.argv[1])",
  "program = base64.b64decode(sys.argv[2])",
  "lib = ctypes.CDLL('/usr/lib/libsandbox.1.dylib')",
  "error = ctypes.c_char_p()",
  "lib.sandbox_init.argtypes = [ctypes.c_char_p, ctypes.c_uint64, ctypes.POINTER(ctypes.c_char_p)]",
  "lib.sandbox_init.restype = ctypes.c_int",
  "if lib.sandbox_init(profile, 0, ctypes.byref(error)) != 0:",
  "    message = error.value.decode('utf-8', 'replace') if error.value else 'unknown sandbox error'",
  "    raise RuntimeError('sandbox_init failed: ' + message)",
  "exec(compile(program, '<relayer-boundary-probe>', 'exec'), {'__name__': '__main__'})",
].join("\n");

function validateKernelLaunch(request: PrimeWorkspaceKernelLaunchRequest, workspaceRoot: string): string {
  if (!isAbsolute(request.command) || resolve(request.command) !== request.command) {
    throw new Error("Prime bounded kernel requires an absolute Python executable path");
  }
  const command = realpathSync(request.command);
  if (!/\/python(?:3(?:\.\d+)?)?$/.test(command)) {
    throw new Error("Prime bounded kernel requires an exact Python executable");
  }
  if (isWithin(workspaceRoot, command)) {
    throw new Error("Prime bounded kernel Python executable must be outside the writable workspace");
  }
  if (request.args.length !== 4
    || request.args[0] !== "-m"
    || request.args[1] !== "ipykernel_launcher"
    || request.args[2] !== "-f"
    || typeof request.args[3] !== "string"
    || !isAbsolute(request.args[3])) {
    throw new Error("Prime bounded kernel requires the canonical ipykernel_launcher invocation");
  }
  // Preserve the admitted venv entrypoint so Python discovers its isolated
  // site-packages; its canonical target was validated outside the workspace.
  return request.command;
}

export function validateInitialJupyterConnectionForSecurityProbe(
  path: string,
  workspaceRoot: string,
): { readonly path: string; readonly directory: string } {
  if (!isAbsolute(path) || resolve(path) !== path || basename(path) !== "connection.json") {
    throw new Error("Prime bounded kernel requires a canonical connection.json path");
  }
  const fileLstat = lstatSync(path);
  const canonicalPath = realpathSync(path);
  if (fileLstat.isSymbolicLink() || canonicalPath !== path || !fileLstat.isFile()) {
    throw new Error("Prime bounded kernel connection must be a canonical regular file");
  }
  if ((fileLstat.mode & 0o077) !== 0 || (fileLstat.mode & 0o200) === 0) {
    throw new Error("Prime bounded kernel connection file must be owner-private and writable");
  }
  const directory = dirname(path);
  const directoryLstat = lstatSync(directory);
  const canonicalDirectory = realpathSync(directory);
  if (directoryLstat.isSymbolicLink()
    || canonicalDirectory !== directory
    || !directoryLstat.isDirectory()
    || !basename(directory).startsWith("prime-agent-kernel-")
    || isWithin(workspaceRoot, directory)
    || (directoryLstat.mode & 0o077) !== 0) {
    throw new Error("Prime bounded kernel connection directory is not a private non-workspace Prime runtime");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
    throw new Error("Prime bounded kernel connection file has an invalid size");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Prime bounded kernel connection file is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prime bounded kernel connection file must be an object");
  }
  const connection = value as Record<string, unknown>;
  const portNames = ["shell_port", "iopub_port", "stdin_port", "control_port", "hb_port"] as const;
  const ports = portNames.map((name) => connection[name]);
  if (connection.transport !== "tcp"
    || connection.ip !== "127.0.0.1"
    || connection.signature_scheme !== "hmac-sha256"
    || typeof connection.key !== "string"
    || connection.key.length === 0
    || connection.key.length > 4096
    || ports.some((port) => port !== 0)) {
    throw new Error("Prime bounded kernel requires five unresolved authenticated loopback TCP channels");
  }
  return Object.freeze({ path: canonicalPath, directory: canonicalDirectory });
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

async function expectExit(child: ChildProcess, expected: number, signal: AbortSignal): Promise<void> {
  const result = await childExit(child, signal);
  if (result !== expected) throw new Error(`Boundary probe exited ${String(result)} instead of ${expected}`);
}

async function expectDenied(child: ChildProcess, deniedPath: string, signal: AbortSignal): Promise<void> {
  const result = await childExit(child, signal);
  if (result === 0) {
    await rm(deniedPath, { force: true });
    throw new Error("Boundary allowed a write outside the workspace");
  }
}

function childExit(child: ChildProcess, signal: AbortSignal): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    const abort = () => {
      terminateProcessTree(child);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Boundary preparation cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      resolveExit(code);
    });
  });
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already terminal */ }
  }
}

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveClose, reject) => {
    const timeout = setTimeout(() => reject(new Error("Prime kernel process did not exit during boundary cleanup")), 5_000);
    timeout.unref();
    child.once("close", () => {
      clearTimeout(timeout);
      resolveClose();
    });
  });
}
