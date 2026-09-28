import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('report', Path(__file__).with_name('report.py'))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ReportTests(unittest.TestCase):
    def test_actual_cargo_mapping_requires_new_targets_and_keeps_doc_feature_obligations(self):
        target = {'name': 'app', 'kind': ['lib'], 'test': True, 'doctest': True}
        metadata = {'workspace_members': ['p'], 'packages': [{'id': 'p', 'targets': [target]}]}
        artifact = {'reason': 'compiler-artifact', 'package_id': 'p', 'target': target,
                    'profile': {'test': True}, 'features': ['default'], 'executable': '/test', 'fresh': True}
        records = [artifact, {'reason': 'build-finished', 'success': True}]
        result = report.mapping(records, metadata)
        self.assertIn('rustdoc', result['deferred'][0]['reason'])
        metadata['packages'][0]['targets'].append({'name': 'new', 'kind': ['test'], 'test': True})
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            report.mapping(records, metadata)
        metadata['packages'][0]['targets'][-1]['required-features'] = ['crash']
        self.assertEqual(report.mapping(records, metadata)['deferred'][-1]['reason'], 'feature-gated')
        metadata['packages'][0]['targets'].append({'name': 'example', 'kind': ['example'], 'test': False})
        with self.assertRaisesRegex(ValueError, 'compile-only example'):
            report.mapping(records, metadata)

    def test_section_failure_preserves_other_evidence_and_never_claims_authority(self):
        def fail():
            raise ValueError('missing provenance')
        result = report.collect({'mapping': lambda: {'count': 21}, 'registry': fail, 'runtime': lambda: ['libc']})
        self.assertEqual(result['sections']['registry']['status'], 'unknown')
        self.assertEqual(result['sections']['runtime']['data'], ['libc'])
        self.assertIn('no transport', result['authority'])

    def test_candidate_loader_recurses_and_retains_unresolved_names(self):
        def inspect(path):
            return {'needed': ['liba', 'missing'] if str(path) == '/test' else ['libb'] if str(path) == '/liba' else [], 'path': str(path)}
        with patch.object(report, 'elf', side_effect=inspect), \
                patch.object(report, 'command', return_value='liba (libc6,x86-64) => /liba\nlibb (libc6,x86-64) => /libb\n'), \
                patch.object(Path, 'resolve', lambda self, **kwargs: self):
            result = report.runtime([{'reason': 'compiler-artifact', 'executable': '/test'}])
        self.assertEqual(set(result['candidateLibraries']), {'liba', 'libb'})
        self.assertEqual(result['unresolved'], {'missing': []})
        self.assertTrue(result['unknowns'])

    def test_real_archive_digest_does_not_admit_extracted_registry_or_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'Cargo.lock').write_text('[[package]]\nname="cxx"\nversion="1"\nchecksum="wrong"\n')
            archive = root / 'registry/cache/index/cxx-1.crate'
            archive.parent.mkdir(parents=True)
            archive.write_bytes(b'archive')
            target = root / 'target'
            target.mkdir()
            result = report.provenance(target, root, root)
            self.assertFalse(result['registryArchives'][0]['archiveMatchesLock'])
            self.assertIn('unknown', result['registryArchives'][0]['extractedSourceQualification'])


if __name__ == '__main__':
    unittest.main()
