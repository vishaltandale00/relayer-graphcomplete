#!/usr/bin/env python3
"""Diagnostic observations only: never installs artifacts or authorizes reuse."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import tomllib


def sha(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def command(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE)


def mapping(records, metadata):
    artifacts = [r for r in records if r.get('reason') == 'compiler-artifact']
    if not any(r.get('reason') == 'build-finished' and r.get('success') for r in records):
        raise ValueError('no successful Cargo build-finished record')
    members = set(metadata['workspace_members'])
    packages = [p for p in metadata['packages'] if p['id'] in members]
    expected, actual, deferred = [], [], []
    for package in packages:
        features = set(f for a in artifacts if a['package_id'] == package['id'] for f in a['features'])
        for target in package['targets']:
            key = [package['id'], target['name'], target['kind']]
            if not set(target.get('required-features', [])).issubset(features):
                deferred.append({'target': key, 'reason': 'feature-gated'})
            elif target['kind'] == ['lib'] and target.get('doctest'):
                deferred.append({'target': key, 'reason': 'fresh rustdoc obligation, not executed by inventory'})
            if (target.get('test') and target['kind'] in (['lib'], ['bin'], ['test'], ['example'])
                    and set(target.get('required-features', [])).issubset(features)):
                expected.append(key)
            if target['kind'] == ['example'] and set(target.get('required-features', [])).issubset(features):
                if not any(a['package_id'] == package['id'] and a['target']['name'] == target['name']
                           and a['target']['kind'] == ['example'] for a in artifacts):
                    raise ValueError('missing compile-only example artifact')
    executables = [a for a in artifacts if a.get('executable') and a['package_id'] in members]
    for artifact in executables:
        if artifact['profile']['test']:
            actual.append([artifact['package_id'], artifact['target']['name'], artifact['target']['kind']])
    if sorted(expected) != sorted(actual):
        raise ValueError('workspace test-target inventory mismatch')
    return {'artifactCount': len(artifacts), 'freshArtifactCount': sum(a['fresh'] for a in artifacts),
            'executables': executables, 'testTargets': actual, 'deferred': deferred,
            'buildScriptRecords': [r for r in records if r.get('reason') == 'build-script-executed'],
            'unknowns': ['Custom harness execution semantics, test ordering and environment are not qualified.',
                         'Inventory success is not fresh test or doctest evidence.']}


def elf(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'nonregular ELF input: {path}')
    dynamic = command('readelf', '-d', str(path))
    headers = command('readelf', '-l', str(path))
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': sha(path),
            'needed': re.findall(r'\(NEEDED\).*?\[(.*?)\]', dynamic),
            'searchPaths': re.findall(r'\((?:RUNPATH|RPATH)\).*?\[(.*?)\]', dynamic),
            'interpreters': re.findall(r'Requesting program interpreter: (.*?)\]', headers)}


def runtime(records):
    paths = sorted(set(r['executable'] for r in records if r.get('reason') == 'compiler-artifact' and r.get('executable')))
    if not paths:
        raise ValueError('no executable artifact inventory')
    executables = [elf(p) for p in paths]
    # ldconfig is candidate resolution only. Do not imitate the loader or certify
    # Cargo's environment, RUNPATH, dlopen, or external process dependencies.
    candidates = {}
    for name, flags, path in re.findall(r'^\s*(\S+) \((.*?)\) => (\S+)$', command('/sbin/ldconfig', '-p'), re.M):
        if 'x86-64' in flags:
            candidates.setdefault(name, set()).add(path)
    pending = [n for e in executables for n in e['needed']]
    libraries, unresolved = {}, {}
    while pending:
        name = pending.pop()
        if name in libraries or name in unresolved:
            continue
        choices = candidates.get(name, set())
        if len(choices) != 1:
            unresolved[name] = sorted(choices)
            continue
        record = elf(Path(next(iter(choices))).resolve(strict=True))
        libraries[name] = record
        pending.extend(record['needed'])
    return {'executables': executables, 'candidateLibraries': libraries, 'unresolved': unresolved,
            'unknowns': ['Candidate ldconfig resolution is not actual loader selection.',
                         'Cargo search environment, dlopen and subprocess dependencies require qualification.']}


def provenance(target, cargo_home, repository):
    links = []
    for directory, dirs, files in os.walk(target, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                try:
                    resolved, error = str(path.resolve(strict=True)), None
                except (OSError, RuntimeError) as failure:
                    resolved, error = None, str(failure)
                links.append({'path': str(path.relative_to(target)), 'destination': os.readlink(path),
                              'resolved': resolved, 'error': error})
    locked = tomllib.loads((repository / 'Cargo.lock').read_text())['package']
    packages = []
    for package in locked:
        if package['name'] not in ('cxx', 'lbug'):
            continue
        archives = list((cargo_home / 'registry/cache').glob(f"*/{package['name']}-{package['version']}.crate"))
        observed = [{'path': str(p), 'sha256': sha(p)} for p in archives]
        packages.append({'name': package['name'], 'version': package['version'],
                         'lockedChecksum': package.get('checksum'), 'archives': observed,
                         'archiveMatchesLock': bool(observed) and all(p['sha256'] == package.get('checksum') for p in observed),
                         'extractedSourceQualification': 'unknown: extracted bytes, reviewed patches and native exclusions not compared'})
    return {'links': links, 'registryArchives': packages,
            'unknowns': ['No external source destination is admitted; archive hashes alone do not qualify extracted sources.']}


def collect(sections):
    result = {'authority': 'diagnostic only; no transport or reuse authorization', 'sections': {}}
    for name, operation in sections.items():
        started = time.monotonic()
        try:
            result['sections'][name] = {'status': 'observed', 'data': operation()}
        except Exception as error:
            result['sections'][name] = {'status': 'unknown', 'error': str(error)}
        result['sections'][name]['elapsedSeconds'] = time.monotonic() - started
    return result


def main():
    parser = argparse.ArgumentParser()
    for name in ('cargo-json', 'metadata', 'target', 'cargo-home', 'repository', 'output'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    def records():
        return [json.loads(line) for line in Path(args.cargo_json).read_text().splitlines() if line.startswith('{')]
    report = collect({
        'mapping': lambda: mapping(records(), json.loads(Path(args.metadata).read_text())),
        'runtime': lambda: runtime(records()),
        'provenance': lambda: provenance(Path(args.target), Path(args.cargo_home), Path(args.repository)),
    })
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
