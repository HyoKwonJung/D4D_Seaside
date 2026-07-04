#!/bin/bash
#==============================================================================
# CableGuard-MVP - start.sh
# Type: node | Default Port: 3000 (matches .env.example)
#
# Convenience wrapper around `npm start` with PID-file-based start/stop/
# status/restart/kill and automatic `npm install` / `.env` bootstrap.
#
# Usage:
#   bash start.sh              Start the project (default)
#   bash start.sh stop         Stop the running project
#   bash start.sh restart      Stop then start
#   bash start.sh status       Show current status
#   bash start.sh kill         Force kill the process
#   bash start.sh start 4000   Start on a specific port
#==============================================================================
set -euo pipefail

PROJECT_NAME="CableGuard-MVP"
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=${2:-${PORT:-3000}}
PID_FILE="$DIR/.pid"
CMD="${1:-start}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "  ${CYAN}*${NC} $*"; }
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}!${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; exit 1; }

get_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return
    fi
    rm -f "$PID_FILE"
  fi
  local pid
  pid=$(lsof -ti :"$PORT" 2>/dev/null | head -1 || true)
  if [ -n "$pid" ]; then
    echo "$pid"
    return
  fi
}

stop_process() {
  local pid
  pid=$(get_pid)
  if [ -z "$pid" ]; then
    log "Not running"
    rm -f "$PID_FILE"
    return 0
  fi

  log "Stopping $PROJECT_NAME (PID $pid) on port $PORT..."
  kill "$pid" 2>/dev/null || true

  for i in {1..10}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      ok "Stopped (PID $pid)"
      rm -f "$PID_FILE"
      return 0
    fi
    sleep 0.5
  done

  warn "Force killing PID $pid..."
  kill -9 "$pid" 2>/dev/null || true
  sleep 0.5
  rm -f "$PID_FILE"
  ok "Force killed (PID $pid)"
}

kill_process() {
  local pid
  pid=$(get_pid)
  if [ -z "$pid" ]; then
    log "Not running"
    rm -f "$PID_FILE"
    return 0
  fi
  warn "Force killing $PROJECT_NAME (PID $pid)..."
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  ok "Killed"
}

show_status() {
  echo ""
  echo -e "  ${BOLD}$PROJECT_NAME${NC}  (port $PORT)"
  echo -e "  ──────────────────────────────────"
  local pid
  pid=$(get_pid)
  if [ -n "$pid" ]; then
    ok "Running (PID $pid)"
    local mem cpu elapsed
    mem=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{printf "%.1f MB", $1/1024}' || echo "?")
    cpu=$(ps -o %cpu= -p "$pid" 2>/dev/null || echo "?")
    elapsed=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ' || echo "?")
    log "Memory: $mem | CPU: $cpu% | Uptime: $elapsed"
    log "URL: http://localhost:$PORT"
  else
    warn "Not running"
  fi
  echo ""
}

case "$CMD" in
  stop)    echo ""; stop_process; echo ""; exit 0 ;;
  kill)    echo ""; kill_process; echo ""; exit 0 ;;
  status)  show_status; exit 0 ;;
  restart) echo ""; stop_process; sleep 1 ;; # fall through to start
  start)   ;; # continue to start
  *)
    echo "Usage: bash start.sh [start|stop|restart|status|kill] [port]"
    exit 1
    ;;
esac

echo ""
echo -e "  ${BOLD}Starting: $PROJECT_NAME${NC}"
echo -e "  ──────────────────────────────────"

EXISTING_PID=$(get_pid)
if [ -n "$EXISTING_PID" ]; then
  warn "Already running (PID $EXISTING_PID) on port $PORT"
  echo -e "  Use \033[1mbash start.sh restart\033[0m to restart"
  echo ""
  exit 1
fi

cd "$DIR"

if [ ! -d "$DIR/node_modules" ]; then
  log "Installing dependencies (npm install)..."
  npm install --no-audit --no-fund
fi

if [ ! -f "$DIR/.env" ] && [ -f "$DIR/.env.example" ]; then
  cp "$DIR/.env.example" "$DIR/.env"
  warn "Created .env from .env.example — set AISSTREAM_API_KEY/DATABASE_URL as needed"
fi

PORT="$PORT" node server.js &

APP_PID=$!
echo "$APP_PID" > "$PID_FILE"

sleep 1
if kill -0 "$APP_PID" 2>/dev/null; then
  ok "Started (PID $APP_PID)"
  log "Port: $PORT"
  log "URL: http://localhost:$PORT"
  echo ""
  trap 'stop_process; exit 0' INT TERM
  wait "$APP_PID" 2>/dev/null || true
else
  rm -f "$PID_FILE"
  fail "Failed to start"
fi
