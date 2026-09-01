#!/bin/sh

set -u

if [ "${RELAYER_SCCACHE_ENABLED:-}" = "true" ] && [ -n "${SCCACHE_PATH:-}" ] && [ -x "$SCCACHE_PATH" ]; then
  exec "$SCCACHE_PATH" "$@"
fi

compiler=$1
shift
exec "$compiler" "$@"
