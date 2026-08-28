"""Run frozen upstream tests against only the candidate HTTPCore package."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
from typing import Any

import pytest


_pytest_main = pytest.main
_real_os_exit = os._exit
_stdout_write = sys.stdout.write
COMPLETION_MARKER = "RELAYER_FROZEN_REGRESSION_COMPLETE"


def load_candidate(workspace: Path) -> Any:
    package = workspace.resolve() / "httpcore"
    specification = importlib.util.spec_from_file_location(
        "httpcore",
        package / "__init__.py",
        submodule_search_locations=[str(package)],
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Unable to load the candidate HTTPCore package.")
    module = importlib.util.module_from_spec(specification)
    sys.modules["httpcore"] = module
    specification.loader.exec_module(module)
    return module


class CandidateLoader:
    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace

    def pytest_sessionstart(self, session: Any) -> None:
        del session
        def blocked_exit(_status: int) -> None:
            raise RuntimeError("Candidate package initialization attempted to terminate the evaluator.")

        os._exit = blocked_exit
        try:
            load_candidate(self.workspace)
        finally:
            os._exit = _real_os_exit


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: regression.py CANDIDATE_WORKSPACE FROZEN_BASELINE")
    candidate = Path(sys.argv[1])
    baseline = Path(sys.argv[2]).resolve()
    for name in ("PYTHONPATH", "PYTEST_ADDOPTS", "PYTEST_PLUGINS"):
        os.environ.pop(name, None)
    os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    tests = baseline / "tests" / "_async"
    result = _pytest_main([
        "-q",
        "-c",
        "/dev/null",
        "-p",
        "no:cacheprovider",
        "-p",
        "anyio.pytest_plugin",
        "-p",
        "pytest_trio.plugin",
        "--confcutdir",
        str(tests),
        str(tests / "test_connection.py"),
        str(tests / "test_connection_pool.py"),
    ], plugins=[CandidateLoader(candidate)])
    _stdout_write(f"{COMPLETION_MARKER}:{result}\n")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
