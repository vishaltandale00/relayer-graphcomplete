"""Small deterministic tests of the actual transport boundary, no compilation."""
import copy
import importlib.util
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

spec = importlib.util.spec_from_file_location("bundle", Path(__file__).with_name("bundle.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.target = self.root / "producer"
        (self.target / "debug/deps").mkdir(parents=True)
        (self.target / "debug/deps/test-binary").write_bytes(b"compiled test")
        (self.target / "debug/deps/test-binary").chmod(0o755)
        (self.target / "debug/server").write_bytes(b"runtime executable")
        self.identity = {"source": "fixture-and-doc-inputs", "features": "default",
                         "image": "pinned", "profile": "test", "native": ["qualified"]}
        self.archive = self.root / "bundle.tar.gz"
        self.receipt = bundle.pack(self.target, self.archive, self.identity)["sha256"]
        self.destination = self.root / "consumer"

    def restore(self, expected=None, receipt=None):
        return bundle.restore(self.archive, self.destination,
                              expected or self.identity, receipt or self.receipt)

    def test_real_roundtrip_preserves_complete_inventory_and_executable_modes(self):
        self.restore()
        self.assertEqual(bundle.inventory(self.target), bundle.inventory(self.destination))

    def test_wrong_inputs_and_corruption_never_install(self):
        for key in self.identity:
            with self.subTest(key=key):
                changed = copy.deepcopy(self.identity)
                changed[key] = "wrong"
                with self.assertRaisesRegex(ValueError, "identity"):
                    self.restore(changed)
                self.assertFalse(self.destination.exists())
        with open(self.archive, "ab") as stream:
            stream.write(b"corruption")
        with self.assertRaisesRegex(ValueError, "receipt"):
            self.restore()
        self.assertFalse(self.destination.exists())

    def rewrite(self, mutation):
        with tarfile.open(self.archive, "r:gz") as archive:
            records = [(member, archive.extractfile(member).read()) for member in archive.getmembers()]
        mutation(records)
        with tarfile.open(self.archive, "w:gz") as archive:
            for member, data in records:
                archive.addfile(member, io.BytesIO(data))
        return bundle.digest(self.archive)

    def test_missing_extra_duplicate_link_and_changed_members_reject_before_install(self):
        original = self.archive.read_bytes()
        def extra(records):
            item = tarfile.TarInfo("target/extra")
            records.append((item, b""))
        def symlink(records):
            records[-1][0].type = tarfile.SYMTYPE
            records[-1][0].linkname = "/tmp/outside"
        def corrupt(records):
            item, data = records[-1]
            records[-1] = (item, b"X" * len(data))
        for mutation in (lambda records: records.pop(), extra,
                         lambda records: records.append(records[-1]), symlink, corrupt):
            with self.subTest(mutation=mutation):
                self.archive.write_bytes(original)
                receipt = self.rewrite(mutation)
                with self.assertRaises(ValueError):
                    self.restore(receipt=receipt)
                self.assertFalse(self.destination.exists())

    def test_traversal_is_rejected_even_with_consistent_manifest_and_receipt(self):
        def mutation(records):
            manifest = json.loads(records[0][1])
            name = manifest["files"][-1]["path"]
            manifest["files"][-1]["path"] = "../../outside"
            for member, _ in records:
                if member.name == "target/" + name:
                    member.name = "target/../../outside"
            data = bundle.encoded(manifest)
            records[0][0].size = len(data)
            records[0] = (records[0][0], data)
        receipt = self.rewrite(mutation)
        with self.assertRaisesRegex(ValueError, "unsafe"):
            self.restore(receipt=receipt)
        self.assertFalse(self.destination.exists())

    def test_actual_source_docs_fixtures_and_added_target_invalidate_identity(self):
        repository = self.root / "repository"
        repository.mkdir()
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        for name in ("crates/lib.rs", "fixtures/query.json", "docs/query.md"):
            path = repository / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("original")
        subprocess.run(["git", "add", "."], cwd=repository, check=True)
        original = bundle.source_identity(repository)
        if os.name != "nt":
            path = repository / "crates/lib.rs"
            path.chmod(0o755)
            self.assertNotEqual(bundle.source_identity(repository), original)
            path.chmod(0o644)
        for name in ("fixtures/query.json", "docs/query.md"):
            path = repository / name
            path.write_text("changed")
            self.assertNotEqual(bundle.source_identity(repository), original)
            path.write_text("original")
        (repository / "crates/new_test.rs").write_text("new target")
        with self.assertRaisesRegex(ValueError, "untracked"):
            bundle.source_identity(repository)
        subprocess.run(["git", "add", "."], cwd=repository, check=True)
        self.assertNotEqual(bundle.source_identity(repository), original)

    def test_cli_revalidates_source_before_pack_and_restore(self):
        repository = self.root / "stale-source"
        repository.mkdir()
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        (repository / "fixture.json").write_text("original")
        subprocess.run(["git", "add", "."], cwd=repository, check=True)
        expected = self.root / "expected.json"
        expected.write_text(json.dumps({"source": bundle.source_identity(repository)}))
        (repository / "fixture.json").write_text("changed after deriving identity")
        for operation in ("pack", "restore"):
            metrics = self.root / f"{operation}-metrics.json"
            result = subprocess.run([
                sys.executable, "-B", str(Path(__file__).with_name("bundle.py")), operation,
                "--repository", str(repository), "--target", str(self.destination),
                "--identity", str(expected), "--archive", str(self.archive),
                "--receipt", self.receipt, "--metrics", str(metrics),
            ], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(metrics.read_text())["error"],
                             "source changed after identity derivation")
            self.assertFalse(self.destination.exists())

    @unittest.skipUnless(sys.platform == "linux", "hosted identity admits Linux only")
    def test_identity_derivation_binds_probed_inputs_and_propagates_native_rejection(self):
        repository = self.root / "identity-repository"
        repository.mkdir()
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        (repository / "source.rs").write_text("source")
        subprocess.run(["git", "add", "."], cwd=repository, check=True)
        native = self.root / "native"
        native.mkdir()
        (native / "lib.a").write_bytes(b"native")
        for name in ("libssl.so", "libcrypto.so"):
            (native / name).write_bytes(name.encode())
        metadata = {"workspace_members": ["app"], "packages": [
            {"id": "app", "name": "app", "targets": [{"kind": ["lib"]}],
             "features": {"default": ["ladybug"]}}]}
        probes = {"rustc": "rustc 1.98.0", "cargo": "cargo 1.98.0",
                  "cc": "compiler", "ld": "linker", "dpkg-query": "runtime=1"}
        original_command = bundle.command
        def probe(*args, **kwargs):
            if args[0] == "git":
                return original_command(*args, **kwargs)
            if args[:2] == ("cargo", "metadata"):
                return json.dumps(metadata)
            if args[0] == "pkg-config":
                return str(native)
            return probes[args[0]]
        environment = {"ImageVersion": "pinned-image", "CARGO_INCREMENTAL": "0",
                       "CARGO_PROFILE_DEV_DEBUG": "line-tables-only",
                       "CARGO_PROFILE_TEST_DEBUG": "line-tables-only",
                       "PATH": os.environ["PATH"]}
        with patch.dict(os.environ, environment, clear=True), \
                patch.object(bundle, "command", side_effect=probe), \
                patch.object(bundle, "qualify_native") as qualify:
            initial = bundle.identity(repository, self.target, native)
            qualify.assert_called_once_with(repository, native)
            probes["rustc"] = "different toolchain"
            self.assertNotEqual(bundle.identity(repository, self.target, native), initial)
            probes["rustc"] = "rustc 1.98.0"
            metadata["packages"][0]["targets"].append({"kind": ["test"]})
            self.assertNotEqual(bundle.identity(repository, self.target, native), initial)
            metadata["packages"][0]["targets"].pop()
            (native / "libssl.so").write_bytes(b"changed runtime")
            self.assertNotEqual(bundle.identity(repository, self.target, native), initial)
            qualify.side_effect = ValueError("production native verifier rejected")
            with self.assertRaisesRegex(ValueError, "native verifier rejected"):
                bundle.identity(repository, self.target, native)
            os.environ["CARGO_PROFILE_TEST_DEBUG"] = "full"
            with self.assertRaisesRegex(ValueError, "unsupported build setting"):
                bundle.identity(repository, self.target, native)


if __name__ == "__main__":
    unittest.main()
