"""Container phases of the reviewed exact-pair experiment; no cache admission API."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from probe import context, digest, file_digest, file_record, inventory
from reuse import execute_test, replay, seal, verify_files, verify_suite, write

SOURCE = Path('/workspace')
TARGET = Path('/target')
EVIDENCE = Path('/evidence')
BUILD = ['cargo', 'test', '--workspace', '--frozen', '--no-run', '--message-format=json']
TEST = ['cargo', 'test', '--workspace', '--frozen', '--lib', '--bins', '--tests', '--message-format=json', '--', '--test-threads=2']
WRITABLE_PACKAGES = ['graph-client', 'visual-assets', 'harness-host']


def runtime_inventory(root, workspace=SOURCE):
    """Hash links as links; mounts resolve workspace package links in the consumer."""
    records = []
    module_root = root.resolve(strict=True)
    package_roots = [p.parent.resolve() for p in (workspace / 'packages').glob('*/package.json')]
    if (workspace / 'desktop/package.json').is_file():
        package_roots.append((workspace / 'desktop').resolve())
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in list(dirs) + files:
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                resolved = path.resolve(strict=True)
                if not any(resolved == allowed or allowed in resolved.parents for allowed in [module_root, *package_roots]):
                    raise ValueError('runtime dependency link escapes declared roots')
                records.append({'path': relative, 'link': os.readlink(path)})
            elif path.is_file():
                records.append(file_record(path, relative))
    return sorted(records, key=lambda r: r['path'])


def runtime_dependency_roots(workspace):
    roots = [workspace / 'node_modules']
    packages = [p.parent for p in (workspace / 'packages').glob('*/package.json')]
    if (workspace / 'desktop/package.json').is_file():
        packages.append(workspace / 'desktop')
    roots.extend(package / 'node_modules' for package in packages)
    return sorted((root for root in roots if root.is_dir()), key=str)


def runtime_dependencies(workspace):
    return {root.relative_to(workspace).as_posix(): runtime_inventory(root, workspace)
            for root in runtime_dependency_roots(workspace)}


def validate_sources(manifest, runtime):
    excluded = {p.relative_to(SOURCE).as_posix() for p in runtime_dependency_roots(SOURCE)} | {f'packages/{name}/dist' for name in WRITABLE_PACKAGES} | {'packages/graph-client/agent-resource'} if runtime else set()
    records = []
    for directory, dirs, files in os.walk(SOURCE, followlinks=False):
        for name in list(dirs):
            path = Path(directory) / name
            relative = path.relative_to(SOURCE).as_posix()
            if relative in excluded:
                dirs.remove(name)
            elif path.is_symlink():
                raise ValueError('linked source directory')
        for name in files:
            path = Path(directory) / name
            records.append(file_record(path, path.relative_to(SOURCE).as_posix()))
    if sorted(records, key=lambda r: r['path']) != manifest:
        raise ValueError('source snapshot mismatch')


def loader_inventory(receipt):
    libraries = {}
    for item in receipt['executables']:
        output = subprocess.check_output(['ldd', str(TARGET / item['path'])], text=True)
        if 'not found' in output:
            raise ValueError('missing shared library')
        for line in output.splitlines():
            if line.strip().startswith('linux-vdso.so.'):
                continue
            match = re.search(r'(?:=>\s+)?(/[^ ]+)\s+\(0x[0-9a-f]+\)', line)
            if not match:
                raise ValueError('unsupported loader dependency')
            path = Path(match[1]).resolve()
            if not any(str(path).startswith(prefix) for prefix in ('/usr/lib/', '/lib/', '/opt/rustup/')):
                raise ValueError('loader dependency outside pinned image')
            libraries[str(path)] = file_digest(path)
    return libraries


def validate_runtime_executables(artifact, expected_loader, exact):
    verify_files(TARGET, artifact, exact=exact)
    if loader_inventory(artifact) != expected_loader:
        raise ValueError('loader drift')


def main():
    phase = sys.argv[1]
    recipe = json.loads(Path('/recipe/recipe.json').read_text())
    manifest = json.loads(Path('/recipe/source.json').read_text())
    expected = recipe['context']
    receipt = {'phase': phase, 'status': 'started', 'completeDigest': None}
    started = time.monotonic()
    runtime = phase in ('baseline', 'replay')
    def validate():
        validate_sources(manifest['stagedFiles'], runtime)
        execution = recipe.get('execution') if runtime else None
        if runtime and not execution:
            raise ValueError('complete runtime execution record required')
        if execution:
            receipt['executionDigest'] = digest(execution)
            if phase == 'replay' and json.loads(Path('/baseline/receipt.json').read_text()).get('executionDigest') != receipt['executionDigest']:
                raise ValueError('baseline/replay execution record mismatch')
        diagnostic = execution['diagnosticFiles'] if execution else recipe['provenance']['recipe']['diagnosticFiles']
        if inventory(Path('/diagnostic')) != diagnostic:
            raise ValueError('diagnostic implementation drift')
        if dict(os.environ) != expected['environment']:
            raise ValueError('undeclared phase environment')
        actual = context(expected['image'], subprocess.check_output(['rustc', '-vV'], text=True),
                         dict(os.environ), Path('/native'), Path('/recipe/registry.json'))
        if actual != expected or inventory(Path('/cargo/registry')) != recipe['registryFiles']:
            raise ValueError('compile context mismatch')
        if runtime:
            actual_dependencies = runtime_dependencies(SOURCE)
            expected_digest = execution['dependenciesDigest']
            if digest(actual_dependencies) != expected_digest:
                raise ValueError('runtime dependency inventory mismatch')
            if execution:
                tmp_mount = next(line.split() for line in Path('/proc/mounts').read_text().splitlines() if line.split()[1] == '/tmp')
                if tmp_mount[2] != 'tmpfs' or 'noexec' in tmp_mount[3].split(',') or execution['tmpExecutable'] is not True:
                    raise ValueError('runtime temporary execution unavailable')
    try:
        Path('/tmp/home').mkdir()
        validate()
        if phase == 'build':
            if list(TARGET.iterdir()):
                raise ValueError('fresh target required')
            with open(EVIDENCE / 'native.log', 'w') as log:
                subprocess.run(['node', 'scripts/ci/lbug-artifact.mjs', 'verify', '--repository', '/workspace',
                                '--artifact-dir', '/native', '--platform', 'Linux-X64', '--rustc-release',
                                re.search(r'^release: (.+)$', expected['toolchain'], re.M)[1]],
                               cwd=SOURCE, stdout=log, stderr=subprocess.STDOUT, check=True)
            metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--offline', '--no-deps', '--format-version', '1'], cwd=SOURCE))
            compile_start = time.monotonic()
            with open(EVIDENCE / 'cargo.jsonl', 'w') as stdout, open(EVIDENCE / 'cargo.stderr', 'w') as stderr:
                result = subprocess.run(BUILD, cwd=SOURCE, stdout=stdout, stderr=stderr)
            receipt.update(compileSeconds=time.monotonic() - compile_start, compileExit=result.returncode)
            if result.returncode:
                raise ValueError('fresh compilation failed')
            artifact = seal(TARGET, EVIDENCE / 'cargo.jsonl', metadata, recipe['provenance'])
            write(EVIDENCE / 'artifacts.json', artifact)
            write(EVIDENCE / 'loader.json', loader_inventory(artifact))
        elif phase == 'baseline':
            artifact = json.loads(Path('/oracle/artifacts.json').read_text())
            validate_runtime_executables(artifact, json.loads(Path('/oracle/loader.json').read_text()), False)
            environment = dict(os.environ, CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER='python3 -B /diagnostic/capture_runner.py')
            execution_start = time.monotonic()
            with open(EVIDENCE / 'cargo.jsonl', 'w') as stdout, open(EVIDENCE / 'cargo.stderr', 'w') as stderr:
                result = subprocess.run(TEST, cwd=SOURCE, env=environment, stdout=stdout, stderr=stderr)
            receipt.update(executionSeconds=time.monotonic() - execution_start, executionExit=result.returncode)
            if result.returncode:
                raise ValueError('baseline tests failed')
            messages = [json.loads(line) for line in (EVIDENCE / 'cargo.jsonl').read_text().splitlines()]
            if not any(m.get('reason') == 'build-finished' and m['success'] for m in messages):
                raise ValueError('baseline Cargo did not finish')
            if any(m.get('reason') == 'compiler-artifact' and not m['fresh'] for m in messages):
                raise ValueError('baseline unexpectedly recompiled')
            runs = sorted((json.loads(p.read_text()) for p in (EVIDENCE / 'tests').glob('*/receipt.json')),
                          key=lambda r: r['startedMonotonicNs'])
            receipt['suite'] = verify_suite(artifact, runs)
            write(EVIDENCE / 'runs.json', runs)
            verify_files(TARGET, artifact)
        elif phase == 'replay':
            artifact = json.loads(Path('/oracle/artifacts.json').read_text())
            runs = json.loads(Path('/baseline/runs.json').read_text())
            validate_runtime_executables(artifact, json.loads(Path('/oracle/loader.json').read_text()), True)
            execution_start = time.monotonic()
            receipt['suite'] = replay(TARGET, artifact, runs, EVIDENCE / 'tests')
            receipt['executionSeconds'] = time.monotonic() - execution_start
        else:
            raise ValueError('unsupported phase')
        validate()
        receipt['status'] = 'passed'
    except Exception as error:
        receipt.update(status='failed', error=str(error))
    finally:
        receipt['elapsedSeconds'] = time.monotonic() - started
        write(EVIDENCE / 'receipt.json', receipt)
    return 0 if receipt['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
