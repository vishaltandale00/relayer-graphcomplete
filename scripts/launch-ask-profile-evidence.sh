#!/bin/sh
# This system-shell script is the trust boundary before the first Node
# or Electron process. Use only shell builtins until every current and future
# runtime override has been removed by prefix, case-insensitively.
saved_ifs=$IFS
IFS='
'
for exported_line in $(export -p); do
  case "$exported_line" in
    "export "*) exported_assignment=${exported_line#export } ;;
    *) continue ;;
  esac
  variable_name=${exported_assignment%%=*}
  case "$variable_name" in
    [Nn][Oo][Dd][Ee]_*|[Nn][Pp][Mm]_*|[Ee][Ll][Ee][Cc][Tt][Rr][Oo][Nn]_*|[Dd][Yy][Ll][Dd]_*|[Ll][Dd]_*|[Oo][Pp][Ee][Nn][Ss][Ss][Ll]_*)
      case "$variable_name" in
        ""|[0-9]*|*[!A-Za-z0-9_]*) ;;
        *) unset "$variable_name" ;;
      esac
      ;;
  esac
done
IFS=$saved_ifs
set -eu

if [ "$(/usr/bin/uname -s)" != "Darwin" ]; then
  echo "Ask-profile desktop evidence capture is supported only on macOS." >&2
  exit 1
fi

if [ "${RELAYER_ASK_PROFILE_LAUNCHER_PROBE:-}" = "1" ]; then
  exec /usr/bin/env
fi

case "$0" in
  /*) launcher_path=$0 ;;
  */*) launcher_path=$(pwd -P)/$0 ;;
  *) echo "Ask-profile evidence launcher must be invoked by path, not through PATH." >&2; exit 1 ;;
esac
script_directory=$(CDPATH= cd "${launcher_path%/*}" && pwd -P)
repository_root=${script_directory%/scripts}

if [ "${RELAYER_ASK_PROFILE_PATH_PROBE:-}" = "1" ]; then
  echo "$repository_root"
  exit 0
fi

# Node is an explicit command-line trust input, never an environment or PATH
# discovery. The operator must select its already-installed trusted copy.
node_path=${1:-}
case "$node_path" in
  /*/node) ;;
  *) echo "Usage: /bin/sh /absolute/path/to/scripts/launch-ask-profile-evidence.sh /absolute/path/to/node" >&2; exit 1 ;;
esac
/usr/bin/codesign --verify --strict "$node_path"

# Refuse mutable bootstrap controls, then materialize the exact committed bytes
# into a private execution root. The checked worktree remains the source/build
# workspace, but Node and Electron never import its mutable control files.
umask 077
bootstrap_root=$(/usr/bin/mktemp -d "/tmp/relayer-ask-bootstrap.XXXXXX")
trap '/bin/rm -rf "$bootstrap_root"' 0 1 2 15
/bin/chmod 700 "$bootstrap_root"
/bin/mkdir "$bootstrap_root/scripts"
source_commit=$(/usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin GIT_NO_REPLACE_OBJECTS=1 \
  /usr/bin/git --no-optional-locks -C "$repository_root" \
  -c core.attributesFile=/dev/null -c core.fsmonitor=false \
  rev-parse "HEAD^{commit}")
case "$source_commit" in
  *[!a-f0-9]*|"") echo "Ask-profile evidence could not pin the source commit." >&2; exit 1 ;;
esac
for control_file in \
  package.json package-lock.json \
  scripts/launch-ask-profile-evidence.sh \
  scripts/launch-ask-profile-evidence.mjs \
  scripts/capture-ask-profile-evidence.mjs \
  scripts/ask-profile-evidence-model.mjs \
  scripts/evidence-capture-integrity.mjs
do
  committed_blob=$(/usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin GIT_NO_REPLACE_OBJECTS=1 \
    /usr/bin/git --no-optional-locks -C "$repository_root" \
    -c core.attributesFile=/dev/null -c core.fsmonitor=false \
    rev-parse "$source_commit:$control_file")
  observed_blob=$(/usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin GIT_NO_REPLACE_OBJECTS=1 \
    /usr/bin/git hash-object --no-filters "$repository_root/$control_file")
  if [ "$observed_blob" != "$committed_blob" ]; then
    echo "Ask-profile evidence refuses modified bootstrap control: $control_file" >&2
    exit 1
  fi
  /usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin GIT_NO_REPLACE_OBJECTS=1 \
    /usr/bin/git --no-optional-locks -C "$repository_root" \
    -c core.attributesFile=/dev/null -c core.fsmonitor=false \
    show "$source_commit:$control_file" > "$bootstrap_root/$control_file"
  /bin/chmod 400 "$bootstrap_root/$control_file"
done

exec 3< "$bootstrap_root/scripts/launch-ask-profile-evidence.mjs"
/bin/rm "$bootstrap_root/scripts/launch-ask-profile-evidence.mjs"
exec "$node_path" --input-type=module - "$bootstrap_root" "$repository_root" "$source_commit" <&3
