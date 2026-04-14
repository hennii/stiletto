#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p logs/server

start_character() {
  local char="$1"
  local env_file=".env.$char"

  if [[ ! -f "$env_file" ]]; then
    echo "  Skipping $char — $env_file not found"
    return
  fi

  local autostart
  autostart=$(grep '^DR_AUTOSTART=' "$env_file" | cut -d= -f2 || true)
  if [[ "${2:-}" != "--force" && "$autostart" == "false" ]]; then
    echo "  Skipping $char — DR_AUTOSTART=false (use: dr start $char to start manually)"
    return
  fi

  local port
  port=$(grep '^DR_PORT=' "$env_file" | cut -d= -f2)

  local char_name
  char_name=$(grep '^DR_CHARACTER=' "$env_file" | cut -d= -f2 | tr '[:upper:]' '[:lower:]')
  local pid_file="logs/server/${char_name}.pid"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "  $char already running (PID $(cat "$pid_file"))"
    return
  fi

  echo "  Starting $char on http://localhost:$port ..."
  (
    # Parse env file line-by-line to handle special characters in values
    # (sourcing as shell script breaks on passwords with (, [, etc.)
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
      export "${line%%=*}=${line#*=}"
    done < "$env_file"
    exec bundle exec ruby server.rb
  ) >> "logs/server/$char.log" 2>&1 &

  echo "  $char started"
}

echo "=== Starting DR client servers ==="
if [[ -n "${1:-}" ]]; then
  start_character "$1" --force
else
  for env_file in .env.*; do
    [[ "$env_file" == *.example ]] && continue
    start_character "${env_file##.env.}"
  done
fi

# Show tabs for running servers only
running=()
for env_file in .env.*; do
  [[ "$env_file" == *.example ]] && continue
  [[ -f "$env_file" ]] || continue
  char="${env_file##.env.}"
  char_name=$(grep '^DR_CHARACTER=' "$env_file" | cut -d= -f2 | tr '[:upper:]' '[:lower:]')
  port=$(grep '^DR_PORT=' "$env_file" | cut -d= -f2)
  api_port=$(grep '^SCRIPT_API_PORT=' "$env_file" | cut -d= -f2)
  pid_file="logs/server/${char_name}.pid"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    running+=("  $char_name  http://localhost:$port  (ScriptAPI $api_port)")
  fi
done

if [[ ${#running[@]} -gt 0 ]]; then
  echo ""
  echo "Running:"
  for line in "${running[@]}"; do
    echo "$line"
  done
fi
echo ""
echo "Stop single server: dr stop [character]"
echo "Stop all servers:   dr stop"
