import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from probe import file_digest
from reuse import admit, execute_test, pack, replay, restore, seal, verify_suite
from reuse_container import validate_sources, runtime_inventory, validate_runtime_executables
from probe import inventory


class ReuseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / 'build'
        (self.target / 'debug/deps').mkdir(parents=True)
        self.script = self.target / 'debug/deps/test'
        self.script.write_text(f'''#!{sys.executable}
import os,sys
if '--list' in sys.argv:
    print('reads_runtime: test')
else:
    assert open('runtime.txt').read() == 'consumer'
    assert os.environ['DECLARED'] == 'present'
    print('test reads_runtime ... ok')
    print('test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s')
''')
        self.script.chmod(0o755)
        self.helper = self.target / 'debug/helper'
        self.helper.write_text('#!/bin/sh\nexit 0\n')
        self.helper.chmod(0o755)
        self.log = self.root / 'cargo.jsonl'
        def artifact(path, test):
            return {'reason': 'compiler-artifact', 'package_id': 'pkg', 'fresh': False,
                    'executable': '/target/' + path, 'target': {'name': path, 'kind': ['test' if test else 'bin']},
                    'profile': {'test': test}, 'features': []}
        self.messages = [artifact('debug/deps/test', True), artifact('debug/helper', False),
                         {'reason': 'build-finished', 'success': True}]
        self.log.write_text('\n'.join(map(json.dumps, self.messages)))
        self.metadata = {'workspace_members': ['pkg'], 'packages': [{'id': 'pkg', 'name': 'pkg', 'manifest_path': '/workspace/pkg/Cargo.toml'}]}
        self.pair = {side: {'revision': rev, 'sourceDigest': rev, 'compileProjection': 'equal', 'recipe': {'image': 'fixed'}}
                     for side, rev in [('producer', 'A'), ('consumer', 'B')]}
        self.a = seal(self.target, self.log, self.metadata, self.pair['producer'])
        self.b = seal(self.target, self.log, self.metadata, self.pair['consumer'])
        self.archive = self.root / 'archive.tar.gz'
        pack(self.target, self.a, self.archive)

    def test_real_transport_and_fresh_execution_preserve_runtime_and_failure(self):
        destination = self.root / 'restored'
        restore(self.archive, file_digest(self.archive), self.a, self.b, self.pair, destination)
        self.script.unlink()
        self.helper.unlink()  # The restored executable must not depend on producer files.
        cwd = self.root / 'consumer'
        cwd.mkdir()
        (cwd / 'runtime.txt').write_text('consumer')
        command = [str(destination / 'debug/deps/test'), '--test-threads=2']
        run = execute_test(command, cwd, {'DECLARED': 'present'}, self.root / 'run')
        self.assertEqual((run['status'], run['passed'], run['cases']), ('passed', 1, ['reads_runtime']))
        (cwd / 'runtime.txt').write_text('stale')
        failed = execute_test(command, cwd, {'DECLARED': 'present'}, self.root / 'failed')
        self.assertEqual(failed['status'], 'failed')
        self.assertNotEqual(failed['exitCode'], 0)
        self.assertTrue((self.root / 'failed/stderr.log').read_text())

    def test_fresh_build_and_exact_pair_oracle_fail_closed(self):
        for mutate in ('fresh', 'completion', 'helper', 'bytes', 'profile', 'pair', 'context'):
            with self.subTest(mutate=mutate):
                a, b, pair = copy.deepcopy(self.a), copy.deepcopy(self.b), copy.deepcopy(self.pair)
                if mutate in ('fresh', 'completion'):
                    messages = copy.deepcopy(self.messages)
                    if mutate == 'fresh':
                        messages[0]['fresh'] = True
                    else:
                        messages.pop()
                    self.log.write_text('\n'.join(map(json.dumps, messages)))
                    with self.assertRaises(ValueError):
                        seal(self.target, self.log, self.metadata, pair['producer'])
                    continue
                if mutate == 'helper':
                    a['executables'].pop()
                elif mutate == 'bytes':
                    a['executables'][0]['sha256'] = 'bad'
                elif mutate == 'profile':
                    a['executables'][0]['features'].append('extra')
                elif mutate == 'pair':
                    pair['producer']['revision'] = 'foreign'
                else:
                    pair['consumer']['recipe']['image'] = 'other'
                    b['provenance'] = pair['consumer']
                with self.assertRaises(ValueError):
                    admit(a, b, pair)

    def test_archive_missing_extra_link_mode_and_corruption_reject(self):
        for mutation in ('missing', 'extra', 'link', 'mode', 'corrupt'):
            with self.subTest(mutation=mutation):
                archive = self.root / (mutation + '.tar.gz')
                with tarfile.open(archive, 'w:gz') as tar:
                    for index, item in enumerate(self.a['executables']):
                        if mutation == 'missing' and index == 0:
                            continue
                        info = tarfile.TarInfo(item['path'])
                        data = (self.target / item['path']).read_bytes()
                        info.mode, info.size = item['mode'], len(data)
                        if index == 0 and mutation == 'link':
                            info.type, info.linkname, info.size = tarfile.SYMTYPE, '/outside', 0
                        if index == 0 and mutation == 'mode':
                            info.mode = 0o777
                        if index == 0 and mutation == 'corrupt':
                            data = b'x' * len(data)
                        tar.addfile(info, io.BytesIO(data))
                    if mutation == 'extra':
                        info = tarfile.TarInfo('../outside')
                        tar.addfile(info, io.BytesIO())
                with self.assertRaises(ValueError):
                    restore(archive, file_digest(archive), self.a, self.b, self.pair, self.root / mutation)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            restore(self.archive, 'wrong', self.a, self.b, self.pair, self.root / 'bad-checksum')

    def test_suite_coverage_and_replay_integrity_stop_before_execution(self):
        run = {'command': ['/target/debug/deps/test'], 'cwd': '/workspace/pkg', 'environment': {},
               'status': 'passed', 'passed': 1, 'ignored': 0, 'cases': ['reads_runtime'], 'startedMonotonicNs': 1}
        self.assertEqual(verify_suite(self.b, [run])['passed'], 1)
        second = copy.deepcopy(self.b)
        second['executables'].append(dict(second['executables'][0], path='debug/deps/second'))
        runs = [dict(run, startedMonotonicNs=2), dict(run, command=['/target/debug/deps/second'], startedMonotonicNs=1)]
        with self.assertRaisesRegex(ValueError, 'order'):
            verify_suite(second, runs)
        with self.assertRaisesRegex(ValueError, 'coverage'):
            verify_suite(self.b, [])
        with self.assertRaisesRegex(ValueError, 'working directory'):
            verify_suite(self.b, [dict(run, cwd='/workspace')])
        destination = self.root / 'restored'
        restore(self.archive, file_digest(self.archive), self.a, self.b, self.pair, destination)
        (destination / 'extra').write_text('ambient')
        with patch('reuse.execute_test') as execute:
            with self.assertRaisesRegex(ValueError, 'unexpected'):
                replay(destination, self.b, [run], self.root / 'replay')
            execute.assert_not_called()

    def test_runtime_source_validation_allows_only_declared_generated_outputs(self):
        source = self.root / 'source'
        source.mkdir()
        (source / 'Cargo.lock').write_text('locked')
        expected = inventory(source)
        generated = source / 'packages/graph-client/agent-resource'
        generated.mkdir(parents=True)
        (generated / 'index.js').write_text('fresh generated output')
        modules = source / 'node_modules'
        modules.mkdir()
        (modules / 'dependency').write_text('fixed dependency')
        (modules / 'link').symlink_to('dependency')
        before = runtime_inventory(modules)
        with patch('reuse_container.SOURCE', source):
            validate_sources(expected, True)
            with self.assertRaisesRegex(ValueError, 'snapshot|nonregular'):
                validate_sources(expected, False)
            (source / 'Cargo.lock').write_text('changed')
            with self.assertRaisesRegex(ValueError, 'snapshot'):
                validate_sources(expected, True)
        (modules / 'dependency').write_text('changed dependency')
        self.assertNotEqual(runtime_inventory(modules), before)
        (modules / 'link').unlink()
        outside = self.root / 'outside'
        outside.write_text('not in declared inputs')
        (modules / 'link').symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'escapes'):
            runtime_inventory(modules)

    def test_runtime_closure_observes_package_local_dependencies_and_rejects_drift(self):
        from reuse_container import runtime_dependencies
        source = self.root / 'nested-source'
        package = source / 'packages/graph-client'
        package.mkdir(parents=True)
        (package / 'package.json').write_text('{"name":"@relayer/graph-client"}')
        expected = inventory(source)
        root_modules = source / 'node_modules'
        local_modules = package / 'node_modules'
        root_modules.mkdir()
        local_modules.mkdir()
        (root_modules / 'parse5').write_text('version 5')
        (local_modules / 'parse5').write_text('version 8 with types')
        before = runtime_dependencies(source)
        self.assertEqual(set(before), {'node_modules', 'packages/graph-client/node_modules'})
        with patch('reuse_container.SOURCE', source):
            validate_sources(expected, True)
        (local_modules / 'parse5').write_text('changed local version')
        self.assertNotEqual(runtime_dependencies(source), before)
        (local_modules / 'escape').symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, 'escapes'):
            runtime_dependencies(source)

    def test_runtime_gate_verifies_bytes_before_loader_inspection(self):
        destination = self.root / 'restored'
        restore(self.archive, file_digest(self.archive), self.a, self.b, self.pair, destination)
        with patch('reuse_container.TARGET', destination), patch('reuse_container.loader_inventory', return_value={}) as loader:
            validate_runtime_executables(self.b, {}, True)
            loader.assert_called_once()
            loader.reset_mock()
            (destination / 'debug/deps/test').write_text('corrupt')
            with self.assertRaisesRegex(ValueError, 'integrity'):
                validate_runtime_executables(self.b, {}, True)
            loader.assert_not_called()

    def test_runtime_requires_complete_execution_record_and_same_baseline_identity(self):
        from reuse_container import main
        source, evidence = self.root / 'runtime-source', self.root / 'runtime-evidence'
        source.mkdir()
        evidence.mkdir()
        recipe = self.root / 'recipe'
        recipe.mkdir()
        (self.root / 'tmp').mkdir()
        (self.root / 'baseline').mkdir()
        (recipe / 'source.json').write_text(json.dumps({'stagedFiles': []}))
        value = {'context': {}, 'provenance': {'recipe': {'diagnosticFiles': []}}}
        (recipe / 'recipe.json').write_text(json.dumps(value))
        def path(value):
            text = str(value)
            if text.startswith(('/recipe/', '/baseline/')) or text == '/tmp/home':
                return self.root / text.lstrip('/')
            return Path(value)
        with patch('reuse_container.Path', side_effect=path), patch('reuse_container.SOURCE', source), \
                patch('reuse_container.EVIDENCE', evidence), patch('reuse_container.subprocess.run') as run, \
                patch('reuse_container.subprocess.check_output') as inspect:
            with patch('sys.argv', ['reuse_container.py', 'baseline']):
                self.assertEqual(main(), 1)
            self.assertEqual(json.loads((evidence / 'receipt.json').read_text())['error'], 'complete runtime execution record required')
            (self.root / 'tmp/home').rmdir()
            value['execution'] = {'diagnosticFiles': [], 'dependenciesDigest': 'new', 'tmpExecutable': True}
            (recipe / 'recipe.json').write_text(json.dumps(value))
            (self.root / 'baseline/receipt.json').write_text(json.dumps({'executionDigest': 'old'}))
            with patch('sys.argv', ['reuse_container.py', 'replay']):
                self.assertEqual(main(), 1)
            self.assertEqual(json.loads((evidence / 'receipt.json').read_text())['error'], 'baseline/replay execution record mismatch')
            run.assert_not_called()
            inspect.assert_not_called()

    def test_phase_rejects_changed_diagnostic_before_any_subprocess(self):
        from reuse_container import main
        source, evidence = self.root / 'source', self.root / 'evidence'
        source.mkdir()
        evidence.mkdir()
        recipe, diagnostic = self.root / 'recipe', self.root / 'diagnostic'
        recipe.mkdir()
        diagnostic.mkdir()
        (self.root / 'tmp').mkdir()
        (recipe / 'source.json').write_text(json.dumps({'stagedFiles': []}))
        (recipe / 'recipe.json').write_text(json.dumps({'context': {}, 'provenance': {'recipe': {'diagnosticFiles': []}}}))
        (diagnostic / 'unexpected.py').write_text('changed harness')
        def path(value):
            text = str(value)
            if text.startswith('/recipe/') or text in ('/diagnostic', '/tmp/home'):
                return self.root / text.lstrip('/')
            return Path(value)
        with patch('sys.argv', ['reuse_container.py', 'build']), patch('reuse_container.Path', side_effect=path), \
                patch('reuse_container.SOURCE', source), patch('reuse_container.EVIDENCE', evidence), \
                patch('reuse_container.subprocess.run') as run, patch('reuse_container.subprocess.check_output') as inspect:
            self.assertEqual(main(), 1)
            run.assert_not_called()
            inspect.assert_not_called()
        receipt = json.loads((evidence / 'receipt.json').read_text())
        self.assertEqual(receipt['error'], 'diagnostic implementation drift')
