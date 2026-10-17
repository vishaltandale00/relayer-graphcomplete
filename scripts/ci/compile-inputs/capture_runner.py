"""Cargo target runner used only to capture the independent consumer baseline."""
import os
from pathlib import Path
import sys
from probe import digest
from reuse import execute_test

if __name__ == '__main__':
    command = sys.argv[1:]
    result = execute_test(command, Path.cwd(), dict(os.environ), Path('/evidence/tests') / digest(command))
    raise SystemExit(0 if result['status'] == 'passed' else 1)
