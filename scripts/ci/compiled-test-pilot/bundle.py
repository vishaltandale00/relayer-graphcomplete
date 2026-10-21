#!/usr/bin/env python3
"""Diagnostic compiled-output transport. Never stores or interprets test results.

The consumer owns identity and the producer job supplies a separate SHA receipt.
Cargo still owns target discovery and executes the ordinary test command after
restore. This is deliberately not wired into the required check context.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time

MAX_BYTES = 6 * 1024**3
MAX_ARCHIVE_BYTES = 1536 * 1024**2


def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def command(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd).decode().strip()


def inventory(root):
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError("inventory root must be a real directory")
    entries = []
    for path in sorted(root.rglob("*")):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"nonregular/linked inventory entry: {path}")
        entries.append({"path": path.relative_to(root).as_posix(),
                        "size": info.st_size, "sha256": digest(path),
                        "mode": stat.S_IMODE(info.st_mode)})
    return entries


def source_identity(repository):
    # Include current bytes, modes and paths, not just HEAD. A new tracked test
    # or an embedded fixture outside crates/ therefore invalidates reuse.
    records = subprocess.check_output(
        ["git", "ls-files", "--stage", "-z"], cwd=repository).split(b"\0")
    source = hashlib.sha256()
    for record in records:
        if not record:
            continue
        header, name = record.split(b"\t", 1)
        mode, _, stage = header.split()
        if mode not in (b"100644", b"100755") or stage != b"0":
            raise ValueError("source must contain only ordinary resolved files")
        path = Path(repository) / os.fsdecode(name)
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"missing/nonregular source: {path}")
        actual_mode = "100755" if path.stat().st_mode & 0o111 else "100644"
        source.update(encoded([actual_mode, os.fsdecode(name), digest(path)]))
    if command("git", "ls-files", "--others", "--exclude-standard", cwd=repository):
        raise ValueError("unexpected untracked source input")
    return source.hexdigest()


def qualify_native(repository, native):
    # Retain the unmodified production 800 MiB policy and source qualification.
    subprocess.run(["node", "scripts/ci/lbug-artifact.mjs", "verify", "--repository",
                    str(repository), "--artifact-dir", str(native), "--platform", "Linux-X64",
                    "--rustc-release", command("rustc", "--version").split()[1]],
                   cwd=repository, check=True)


def identity(repository, target, native):
    if os.uname().sysname != "Linux" or not os.environ.get("ImageVersion"):
        raise ValueError("pilot requires a versioned GitHub Linux runner image")
    # An image rollout is a miss. The exact image stamp plus installed package
    # inventory and OpenSSL bytes bind the dynamic runtime (not ubuntu-latest).
    build_env = {k: v for k, v in sorted(os.environ.items()) if
                 k.startswith(("CARGO_", "RUST", "LBUG_", "OPENSSL_", "CMAKE_"))
                 or k in ("CC", "CXX", "AR", "LD", "CFLAGS", "CXXFLAGS",
                          "LDFLAGS", "PKG_CONFIG_PATH", "LIBRARY_PATH",
                          "LD_LIBRARY_PATH", "SCCACHE_GHA_VERSION")}
    required = {"CARGO_INCREMENTAL": "0", "CARGO_PROFILE_DEV_DEBUG": "line-tables-only",
                "CARGO_PROFILE_TEST_DEBUG": "line-tables-only"}
    for key, value in required.items():
        if build_env.get(key) != value:
            raise ValueError(f"unsupported build setting: {key}")
    metadata = json.loads(command("cargo", "metadata", "--locked", "--no-deps",
                                  "--format-version", "1", cwd=repository))
    packages = sorted(p["name"] for p in metadata["packages"]
                      if p["id"] in metadata["workspace_members"])
    target_contract = [{"package": p["name"], "targets": p["targets"],
                        "features": p["features"]} for p in metadata["packages"]
                       if p["id"] in metadata["workspace_members"]]
    openssl_dir = Path(command("pkg-config", "--variable=libdir", "openssl"))
    openssl = {name: digest((openssl_dir / name).resolve())
               for name in ("libssl.so", "libcrypto.so")}
    qualify_native(repository, native)
    return {"version": 1, "source": source_identity(repository),
            "image": {"os": os.environ.get("ImageOS"), "version": os.environ["ImageVersion"],
                      "packages": command("dpkg-query", "-W", "-f=${Package}=${Version}\n"),
                      "osRelease": Path("/etc/os-release").read_text(), "openssl": openssl},
            "rustc": command("rustc", "-vV"), "cargo": command("cargo", "-V"),
            "cc": command("cc", "--version"), "ld": command("ld", "--version"),
            "workspace": str(Path(repository).resolve()), "target": str(Path(target).resolve()),
            "cargoHome": os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")),
            "environment": build_env, "native": inventory(native),
            "packages": packages, "targetContract": target_contract,
            "features": "default", "profile": "test-line-tables-only",
            "command": ["node", "scripts/ci/run-chapter.mjs", "rust-tests"]}


def pack(target, output, expected):
    target, output = Path(target), Path(output)
    files = inventory(target)
    if not files or sum(f["size"] for f in files) > MAX_BYTES:
        raise ValueError("empty or over-budget compilation inventory")
    manifest = {"identity": expected, "files": files}
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
        manifest_file = Path(temporary) / "manifest.json"
        manifest_file.write_bytes(encoded(manifest))
        staged = Path(temporary) / "bundle.tar.gz"
        # Cargo may hardlink its top-level binaries to deps/. Store each path
        # as ordinary bytes; never admit archive links at the consumer.
        with tarfile.open(staged, "w:gz", compresslevel=1, dereference=True) as archive:
            archive.add(manifest_file, arcname="manifest.json", recursive=False)
            for entry in files:
                archive.add(target / entry["path"], arcname="target/" + entry["path"], recursive=False)
        if staged.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ValueError("compiled archive exceeds pilot cache budget")
        shutil.move(staged, output)
    return {"sha256": digest(output), "archiveBytes": output.stat().st_size,
            "unpackedBytes": sum(f["size"] for f in files), "fileCount": len(files)}


def restore(archive_path, target, expected, receipt):
    archive_path, target = Path(archive_path), Path(target)
    # Receipt is supplied by the producer job output, outside the cached archive.
    if (archive_path.stat().st_size > MAX_ARCHIVE_BYTES or
            digest(archive_path) != receipt):
        raise ValueError("archive receipt mismatch")
    if target.exists():
        raise ValueError("restore destination must be absent")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
        staging = Path(temporary) / "target"
        staging.mkdir()
        with tarfile.open(archive_path, "r:gz") as archive:
            members = archive.getmembers()
            names = [m.name for m in members]
            if len(names) != len(set(names)) or any(not m.isfile() for m in members):
                raise ValueError("duplicate or nonregular archive member")
            if sum(m.size for m in members) > MAX_BYTES + 16 * 1024**2:
                raise ValueError("expanded archive exceeds budget")
            manifest_member = archive.getmember("manifest.json")
            if manifest_member.size > 16 * 1024**2:
                raise ValueError("oversize manifest")
            manifest = json.load(archive.extractfile(manifest_member))
            if manifest["identity"] != expected:
                raise ValueError("consumer input identity mismatch")
            files = manifest["files"]
            declared = ["target/" + entry["path"] for entry in files]
            if (not files or len(declared) != len(set(declared)) or
                    sorted(names) != sorted(["manifest.json", *declared])):
                raise ValueError("archive inventory mismatch")
            for entry in files:
                name = entry["path"]
                if (not name or name.startswith("/") or "\\" in name or
                        any(part in ("", ".", "..") for part in name.split("/"))):
                    raise ValueError("unsafe inventory path")
                member = archive.getmember("target/" + name)
                if member.size != entry["size"] or entry["mode"] not in (0o644, 0o755, 0o600, 0o700):
                    raise ValueError("size/mode mismatch")
                path = staging / name
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, open(path, "xb") as destination:
                    shutil.copyfileobj(source, destination)
                if digest(path) != entry["sha256"]:
                    raise ValueError("compiled file digest mismatch")
                path.chmod(entry["mode"])
                os.utime(path, (member.mtime, member.mtime))
        # Installation is atomic; failed validation leaves no executable target.
        staging.rename(target)
    return {"installedFiles": len(files)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["identity", "pack", "restore"])
    parser.add_argument("--repository", default=".")
    parser.add_argument("--target", required=True)
    parser.add_argument("--native")
    parser.add_argument("--identity", required=True)
    parser.add_argument("--archive")
    parser.add_argument("--receipt")
    parser.add_argument("--metrics", required=True)
    args = parser.parse_args()
    started = time.monotonic()
    result = {}
    try:
        if args.operation == "identity":
            result = identity(Path(args.repository).resolve(), args.target, args.native)
            Path(args.identity).write_bytes(encoded(result))
            result = {"identitySha256": digest(args.identity)}
        else:
            expected = json.loads(Path(args.identity).read_text())
            if source_identity(Path(args.repository).resolve()) != expected["source"]:
                raise ValueError("source changed after identity derivation")
            if args.operation == "pack":
                result = pack(args.target, args.archive, expected)
            else:
                result = restore(args.archive, args.target, expected, args.receipt)
        result["outcome"] = "success"
    except Exception as error:
        result = {"outcome": "rejected", "error": str(error)}
        raise
    finally:
        result.update(operation=args.operation, elapsedSeconds=time.monotonic() - started)
        Path(args.metrics).write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
