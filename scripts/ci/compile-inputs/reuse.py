"""Exact-pair executable transport diagnostic, never a reusable cache authority."""
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import time
from probe import digest, file_record, inventory


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def relative(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or str(path) != name or not name:
        raise ValueError('unsafe artifact path')
    return name


def executable_record(root, name):
    relative(name)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('artifact root must be a real directory')
    path = root / name
    for parent in path.parents:
        if parent == root:
            break
        if parent.is_symlink():
            raise ValueError('linked artifact ancestor')
    record = file_record(path, name)
    if not record['mode'] & 0o111:
        raise ValueError('artifact is not executable')
    record['size'] = path.stat().st_size
    return record


def seal(target, cargo_log, metadata, provenance):
    """Inventory all Cargo-emitted executables, including ordinary helper binaries."""
    messages = [json.loads(line) for line in cargo_log.read_text().splitlines()]
    if not messages or messages[-1] != {'reason': 'build-finished', 'success': True}:
        raise ValueError('missing successful Cargo completion')
    packages = {p['id']: p for p in metadata['packages'] if p['id'] in metadata['workspace_members']}
    records = []
    for message in messages:
        if message.get('reason') != 'compiler-artifact':
            continue
        if message['fresh'] is not False:
            raise ValueError('build was not fresh')
        if not message.get('executable'):
            continue
        package = packages[message['package_id']]
        name = str(PurePosixPath(message['executable']).relative_to('/target'))
        item = executable_record(target, name)
        item.update(package=package['name'], manifest=package['manifest_path'],
                    target=message['target'], profile=message['profile'], features=message['features'])
        records.append(item)
    if not records or not any(r['profile']['test'] for r in records):
        raise ValueError('empty executable test inventory')
    if len({r['path'] for r in records}) != len(records):
        raise ValueError('duplicate executable')
    return {'version': 1, 'completeDigest': None, 'provenance': provenance,
            'executables': sorted(records, key=lambda r: r['path'])}


def verify_files(target, receipt, exact=False):
    for expected in receipt['executables']:
        actual = executable_record(target, expected['path'])
        if actual != {k: expected[k] for k in actual}:
            raise ValueError('executable integrity mismatch')
    if exact and {r['path'] for r in inventory(target)} != {r['path'] for r in receipt['executables']}:
        raise ValueError('unexpected restored file')


def admit(producer, baseline, pair):
    if producer['completeDigest'] is not None or baseline['completeDigest'] is not None:
        raise ValueError('diagnostic cannot certify complete identity')
    if pair['producer']['revision'] == pair['consumer']['revision']:
        raise ValueError('cross-revision pair required')
    for key, receipt in (('producer', producer), ('consumer', baseline)):
        if receipt['provenance'] != pair[key]:
            raise ValueError('source-pair provenance mismatch')
    for key in ('compileProjection', 'recipe'):
        if pair['producer'][key] != pair['consumer'][key]:
            raise ValueError('declared compilation context mismatch')
    if producer['executables'] != baseline['executables']:
        raise ValueError('independent consumer executable oracle mismatch')


def pack(target, receipt, archive):
    verify_files(target, receipt)
    # Explicit regular-file entries avoid target links and duplicate hardlink semantics.
    with open(archive, 'xb') as output, gzip.GzipFile(fileobj=output, mode='wb', compresslevel=1, mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode='w|') as tar:
            for item in receipt['executables']:
                info = tarfile.TarInfo(relative(item['path']))
                info.size, info.mode = item['size'], item['mode']
                with open(target / item['path'], 'rb') as incoming:
                    tar.addfile(info, incoming)
    verify_files(target, receipt)
    inspect_archive(archive, receipt)


def restore(archive, archive_sha256, producer, baseline, pair, target):
    from probe import file_digest
    admit(producer, baseline, pair)
    if target.exists():
        raise ValueError('restore destination must be absent')
    if file_digest(archive) != archive_sha256:
        raise ValueError('transport checksum mismatch')
    target.mkdir()
    inspect_archive(archive, baseline, target)
    verify_files(target, baseline, exact=True)


def inspect_archive(archive, baseline, target=None):
    """Verify every member before publication; optionally install the same bytes."""
    expected = {relative(r['path']): r for r in baseline['executables']}
    seen = set()
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            name = relative(member.name)
            if name not in expected or name in seen or not member.isfile():
                raise ValueError('unexpected archive member')
            item = expected[name]
            if member.size != item['size'] or member.mode != item['mode']:
                raise ValueError('archive size or mode mismatch')
            seen.add(name)
            output = None
            if target is not None:
                path = target / name
                path.parent.mkdir(parents=True, exist_ok=True)
                output = open(path, 'xb')
            checksum = hashlib.sha256()
            try:
                with tar.extractfile(member) as incoming:
                    while chunk := incoming.read(1024 * 1024):
                        checksum.update(chunk)
                        if output is not None:
                            output.write(chunk)
            finally:
                if output is not None:
                    output.close()
            if checksum.hexdigest() != item['sha256']:
                raise ValueError('archive member integrity mismatch')
            if target is not None:
                path.chmod(item['mode'])
    if seen != set(expected):
        raise ValueError('missing executable')


def execute_test(command, cwd, environment, output):
    """Preserve a real Cargo invocation and require complete libtest evidence."""
    output.mkdir(parents=True, exist_ok=False)
    receipt = {'command': command, 'cwd': str(cwd), 'environment': environment, 'status': 'started',
               'startedMonotonicNs': time.monotonic_ns()}
    write(output / 'receipt.json', receipt)
    started = time.monotonic()
    try:
        listed = subprocess.run([command[0], '--list', '--format', 'terse'], cwd=cwd,
                                env=environment, capture_output=True, text=True, check=True)
        (output / 'list.log').write_text(listed.stdout)
        (output / 'list.stderr').write_text(listed.stderr)
        for line in listed.stdout.splitlines():
            if line and not line.endswith(': test') and not re.fullmatch(r'\d+ tests?, 0 benchmarks?', line):
                raise ValueError('unsupported libtest listing')
        cases = [line[:-6] for line in listed.stdout.splitlines() if line.endswith(': test')]
        if len(cases) != len(set(cases)):
            raise ValueError('duplicate libtest case')
        receipt['cases'] = sorted(cases)
        with open(output / 'stdout.log', 'w') as stdout, open(output / 'stderr.log', 'w') as stderr:
            result = subprocess.run(command, cwd=cwd, env=environment, stdout=stdout, stderr=stderr)
        receipt['exitCode'] = result.returncode
        text = (output / 'stdout.log').read_text()
        summaries = re.findall(r'^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;', text, re.M)
        if result.returncode or len(summaries) != 1:
            raise ValueError('test execution failed or lacks libtest summary')
        passed, failed, ignored, measured, filtered = map(int, summaries[0])
        if failed or measured or filtered or passed + ignored != len(cases):
            raise ValueError('test execution did not cover listed cases')
        receipt.update(status='passed', passed=passed, ignored=ignored)
    except Exception as error:
        receipt.update(status='failed', error=str(error))
    finally:
        receipt['elapsedSeconds'] = time.monotonic() - started
        write(output / 'receipt.json', receipt)
    return receipt


def verify_suite(receipt, runs):
    expected = {str(PurePosixPath('/target') / r['path']): r for r in receipt['executables'] if r['profile']['test']}
    if len(runs) != len(expected) or {r['command'][0] for r in runs} != set(expected):
        raise ValueError('test executable coverage mismatch')
    ordering = [r['startedMonotonicNs'] for r in runs]
    if ordering != sorted(set(ordering)):
        raise ValueError('invalid observed test order')
    for run in runs:
        item = expected[run['command'][0]]
        if run['status'] != 'passed' or run['cwd'] != str(PurePosixPath(item['manifest']).parent):
            raise ValueError('test failure or package working directory mismatch')
    return {'executables': len(runs), 'passed': sum(r['passed'] for r in runs),
            'ignored': sum(r['ignored'] for r in runs), 'completeDigest': None}


def replay(target, baseline, runs, output):
    verify_suite(baseline, runs)
    verify_files(target, baseline, exact=True)
    result = []
    for run in runs:
        actual = execute_test(run['command'], Path(run['cwd']), run['environment'], output / digest(run['command']))
        result.append(actual)
        if actual.get('cases') != run['cases'] or actual['status'] != 'passed':
            raise ValueError('fresh replay failed or case inventory changed')
    verify_files(target, baseline, exact=True)
    return verify_suite(baseline, result)
