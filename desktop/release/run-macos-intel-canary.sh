#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --seed-dmg PATH --seed-release-receipt PATH --target-dmg PATH --target-release-receipt PATH --preview-publication-receipt PATH --evidence-directory PATH" >&2
  exit 2
}

seed_dmg=""
seed_receipt=""
target_dmg=""
target_receipt=""
publication_receipt=""
evidence_directory=""
timeout_seconds=1800
while (($#)); do
  case "$1" in
    --seed-dmg) seed_dmg="${2:-}"; shift 2 ;;
    --seed-release-receipt) seed_receipt="${2:-}"; shift 2 ;;
    --target-dmg) target_dmg="${2:-}"; shift 2 ;;
    --target-release-receipt) target_receipt="${2:-}"; shift 2 ;;
    --preview-publication-receipt) publication_receipt="${2:-}"; shift 2 ;;
    --evidence-directory) evidence_directory="${2:-}"; shift 2 ;;
    --timeout-seconds) timeout_seconds="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$seed_dmg" && -n "$seed_receipt" && -n "$target_dmg" && -n "$target_receipt" && -n "$publication_receipt" && -n "$evidence_directory" ]] || usage
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "x86_64" ]] || { echo "The Intel canary requires native x86_64 macOS." >&2; exit 1; }
[[ "$timeout_seconds" =~ ^[0-9]+$ ]] || { echo "--timeout-seconds must be numeric." >&2; exit 1; }

script_directory="$(cd "$(dirname "$0")" && pwd)"
seed_dmg="$(cd "$(dirname "$seed_dmg")" && pwd)/$(basename "$seed_dmg")"
seed_receipt="$(cd "$(dirname "$seed_receipt")" && pwd)/$(basename "$seed_receipt")"
target_dmg="$(cd "$(dirname "$target_dmg")" && pwd)/$(basename "$target_dmg")"
target_receipt="$(cd "$(dirname "$target_receipt")" && pwd)/$(basename "$target_receipt")"
publication_receipt="$(cd "$(dirname "$publication_receipt")" && pwd)/$(basename "$publication_receipt")"
mkdir -p "$evidence_directory"
evidence_directory="$(cd "$evidence_directory" && pwd)"

json_value() {
  node -e 'const fs=require("fs"); const value=process.argv[2].split(".").reduce((item,key)=>item?.[key], JSON.parse(fs.readFileSync(process.argv[1],"utf8"))); if (value == null) process.exit(2); process.stdout.write(String(value));' "$1" "$2"
}

artifact_sha() {
  node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const item=value.artifacts.find((entry)=>entry.name===process.argv[2]); if (!item?.sha256) process.exit(2); process.stdout.write(item.sha256);' "$1" "$2"
}

verify_dmg() {
  local dmg="$1" receipt="$2"
  local expected actual
  expected="$(artifact_sha "$receipt" "$(basename "$dmg")")"
  actual="$(shasum -a 256 "$dmg" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "DMG SHA-256 does not match its receipt: $dmg" >&2; exit 1; }
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
}

verify_app() {
  local app="$1" expected_version="$2"
  codesign --verify --deep --strict --verbose=2 "$app"
  spctl --assess --type execute --verbose=4 "$app"
  xcrun stapler validate "$app"
  [[ "$(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString)" == "$expected_version" ]] || {
    echo "Relayer.app version does not match $expected_version." >&2
    exit 1
  }
  [[ "$(lipo -archs "$app/Contents/MacOS/Relayer")" == "x86_64" ]] || {
    echo "Relayer.app is not a native Intel-only application." >&2
    exit 1
  }
}

install_dmg() {
  local dmg="$1" destination="$2"
  local mount
  mount="$(mktemp -d "${TMPDIR:-/tmp}/relayer-canary-mount.XXXXXX")"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" >/dev/null
  trap 'hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount"' RETURN
  [[ -d "$mount/Relayer.app" ]] || { echo "DMG does not contain Relayer.app." >&2; exit 1; }
  rm -rf "$destination"
  ditto "$mount/Relayer.app" "$destination"
  hdiutil detach "$mount" >/dev/null
  rm -rf "$mount"
  trap - RETURN
}

wait_for_target_trace() {
  local log="$1" target_version="$2" seed_pid="$3" deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)); do
    if [[ -s "$log" ]] && node -e '
      const fs=require("fs");
      const records=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const found=records.some((record)=>record.state?.phase==="idle" && record.state.version===process.argv[2] && record.state.channel==="preview" && String(record.processId)!==process.argv[3]);
      process.exit(found ? 0 : 1);
    ' "$log" "$target_version" "$seed_pid"; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for the Intel target to relaunch." >&2
  return 1
}

target_process_id_from_trace() {
  local log="$1" target_version="$2"
  node "$script_directory/canary-evidence.mjs" \
    --print-target-process-id \
    --state-log "$log" \
    --target-version "$target_version" \
    --target macos-x64
}

terminate_process() {
  local process_id="$1" label="$2" deadline=$((SECONDS + 30))
  if ! kill "$process_id"; then
    echo "Failed to terminate $label process $process_id." >&2
    return 1
  fi
  while kill -0 "$process_id" >/dev/null 2>&1 && ((SECONDS < deadline)); do
    sleep 1
  done
  if kill -0 "$process_id" >/dev/null 2>&1; then
    echo "$label process $process_id did not exit after SIGTERM." >&2
    return 1
  fi
}

seed_version="$(json_value "$seed_receipt" version)"
target_version="$(json_value "$target_receipt" version)"
[[ "$(json_value "$seed_receipt" target)" == "macos-x64" && "$(json_value "$target_receipt" target)" == "macos-x64" ]] || {
  echo "Both receipts must be Intel macOS candidates." >&2
  exit 1
}
[[ "$(json_value "$publication_receipt" target)" == "macos-x64" && "$(json_value "$publication_receipt" version)" == "$target_version" ]] || {
  echo "Preview publication receipt does not match the Intel target." >&2
  exit 1
}

verify_dmg "$seed_dmg" "$seed_receipt"
verify_dmg "$target_dmg" "$target_receipt"

runtime_directory="$(mktemp -d "${TMPDIR:-/tmp}/relayer-intel-canary.XXXXXX")"
install_root="$runtime_directory/Applications"
application="$install_root/Relayer.app"
mkdir -p "$install_root"
first_install_screenshot="$evidence_directory/macos-intel-target-first-install.png"
available_screenshot="$evidence_directory/macos-intel-preview-available.png"
ready_screenshot="$evidence_directory/macos-intel-preview-ready.png"
installed_screenshot="$evidence_directory/macos-intel-preview-installed.png"
live_state_log="$runtime_directory/macos-intel-preview-update.live.jsonl"
state_log="$evidence_directory/macos-intel-preview-update.jsonl"
output="$evidence_directory/macos-intel-preview-canary.json"

install_dmg "$target_dmg" "$application"
verify_app "$application" "$target_version"
RELAYER_DESKTOP_USER_DATA_DIR="$runtime_directory/first-install-user-data" \
  "$application/Contents/MacOS/Relayer" --remote-debugging-port=9228 >"$evidence_directory/first-install.log" 2>&1 &
first_install_pid=$!
node "$script_directory/electron-cdp-canary.mjs" --mode capture --port 9228 --screenshot "$first_install_screenshot" --timeout-seconds 60
kill "$first_install_pid" >/dev/null 2>&1 || true
wait "$first_install_pid" >/dev/null 2>&1 || true

install_dmg "$seed_dmg" "$application"
verify_app "$application" "$seed_version"
update_user_data="$runtime_directory/update-user-data"
mkdir -p "$update_user_data"
printf '%s\n' '{"appearance":"light","updateChannel":"preview"}' >"$update_user_data/desktop-settings.json"
rm -f "$live_state_log" "$state_log"
previous_user_data="$(launchctl getenv RELAYER_DESKTOP_USER_DATA_DIR 2>/dev/null || true)"
previous_canary_log="$(launchctl getenv RELAYER_DESKTOP_CANARY_LOG 2>/dev/null || true)"
restore_launch_environment() {
  if [[ -n "$previous_user_data" ]]; then
    launchctl setenv RELAYER_DESKTOP_USER_DATA_DIR "$previous_user_data"
  else
    launchctl unsetenv RELAYER_DESKTOP_USER_DATA_DIR >/dev/null 2>&1 || true
  fi
  if [[ -n "$previous_canary_log" ]]; then
    launchctl setenv RELAYER_DESKTOP_CANARY_LOG "$previous_canary_log"
  else
    launchctl unsetenv RELAYER_DESKTOP_CANARY_LOG >/dev/null 2>&1 || true
  fi
}
preserve_failed_canary_diagnostics() {
  local exit_status=$?
  set +e
  if ((exit_status != 0)) && [[ -s "$live_state_log" ]]; then
    install -m 600 "$live_state_log" "$evidence_directory/macos-intel-preview-update.partial.jsonl" >/dev/null 2>&1 || true
  fi
  restore_launch_environment
  exit "$exit_status"
}
trap preserve_failed_canary_diagnostics EXIT
launchctl setenv RELAYER_DESKTOP_USER_DATA_DIR "$update_user_data"
launchctl setenv RELAYER_DESKTOP_CANARY_LOG "$live_state_log"
RELAYER_DESKTOP_USER_DATA_DIR="$update_user_data" \
RELAYER_DESKTOP_CANARY_LOG="$live_state_log" \
  "$application/Contents/MacOS/Relayer" --remote-debugging-port=9229 >"$evidence_directory/seed-update.log" 2>&1 &
seed_pid=$!
node "$script_directory/electron-cdp-canary.mjs" \
  --mode update \
  --port 9229 \
  --target-version "$target_version" \
  --screenshot-available "$available_screenshot" \
  --screenshot-ready "$ready_screenshot" \
  --timeout-seconds "$timeout_seconds"
wait_for_target_trace "$live_state_log" "$target_version" "$seed_pid"
updated_pid="$(target_process_id_from_trace "$live_state_log" "$target_version")"
verify_app "$application" "$target_version"

terminate_process "$updated_pid" "Updater-relaunched Relayer"
RELAYER_DESKTOP_USER_DATA_DIR="$update_user_data" \
RELAYER_DESKTOP_CANARY_LOG="$live_state_log" \
  "$application/Contents/MacOS/Relayer" --remote-debugging-port=9230 >"$evidence_directory/target-relaunch.log" 2>&1 &
target_pid=$!
node "$script_directory/electron-cdp-canary.mjs" \
  --mode capture-installed \
  --port 9230 \
  --target-version "$target_version" \
  --screenshot "$installed_screenshot" \
  --timeout-seconds 60
if ! kill "$target_pid"; then
  echo "Relayer exited before final Intel canary teardown." >&2
  exit 1
fi
wait "$target_pid" >/dev/null 2>&1 || true
if pgrep -f "$application/Contents/MacOS/Relayer" >/dev/null; then
  echo "Relayer is still running after the final Intel canary capture." >&2
  exit 1
fi
restore_launch_environment
trap - EXIT
install -m 600 "$live_state_log" "$state_log"

node "$script_directory/canary-evidence.mjs" \
  --target-release-receipt "$target_receipt" \
  --preview-publication-receipt "$publication_receipt" \
  --seed-release-receipt "$seed_receipt" \
  --state-log "$state_log" \
  --screenshot-first-install "$first_install_screenshot" \
  --screenshot-available "$available_screenshot" \
  --screenshot-ready "$ready_screenshot" \
  --screenshot-installed "$installed_screenshot" \
  --output "$output" \
  --host "$(scutil --get ComputerName 2>/dev/null || hostname)" \
  --os "macOS $(sw_vers -productVersion)" \
  --architecture x64 \
  --running true \
  --signature-verified true \
  --platform-acceptance-verified true

echo "Intel macOS canary evidence written to $output"
