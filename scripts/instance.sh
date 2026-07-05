#!/usr/bin/env bash
# Point THIS terminal at ONE Loop Browser instance (one restaurant/site) and start it.
# MUST be sourced so the env sticks in your shell:
#   source scripts/instance.sh <site> [port]
#     source scripts/instance.sh linkedin     # remembered: CDP :9222
#     source scripts/instance.sh whatsapp     # remembered: CDP :9223
#     source scripts/instance.sh notion       # NEW site → auto-picks the next free port, remembers it
#
# THE KITCHEN RULE: one site ↔ one CDP port ↔ one stable login profile.
#   • First open of a site → auto-assigns the next FREE port and REMEMBERS it.
#   • Re-open a known site → reuses its port + profile (login persists — no relogin).
#   • A new platform never lands on a port already in use by another site.
# The map lives in ~/.loop-profiles/instances.json (per-machine, never committed).
# See it any time:  node scripts/instances.mjs list
# After sourcing, every `loop` / cook command in this terminal drives that instance.
# Profiles live OUTSIDE the repo (login = your key). Works in bash & zsh.
# Crons do NOT source this — set LOOP_CDP_PORT / LOOP_PROFILE_DIR directly in the launchd plist
# (read the remembered values from `node scripts/instances.mjs list`).

# Refuse to run un-sourced (the exports would vanish the moment the script exits).
_lb_sourced=0
if [ -n "${ZSH_VERSION:-}" ]; then case "$ZSH_EVAL_CONTEXT" in *:file*) _lb_sourced=1;; esac
elif [ -n "${BASH_VERSION:-}" ]; then [ "${BASH_SOURCE[0]}" != "$0" ] && _lb_sourced=1; fi
if [ "$_lb_sourced" -ne 1 ]; then
  echo "✗ source it:  source scripts/instance.sh <site> [port]"; exit 1
fi

_lb_site="${1:-}"
[ -z "$_lb_site" ] && { echo "usage: source scripts/instance.sh <site> [port]"; return 1; }

# Locate this script's repo root (works when sourced, in bash & zsh).
if [ -n "${ZSH_VERSION:-}" ]; then _lb_self="${(%):-%x}"; else _lb_self="${BASH_SOURCE[0]}"; fi
_lb_root="$(cd "$(dirname "$_lb_self")/.." && pwd)"

# Resolve via the registry: auto free-port for a new site, remembered port for a known one.
_lb_resolved="$(node "$_lb_root/scripts/instances.mjs" resolve "$_lb_site" "${2:-}")" \
  || { echo "✗ instance resolve failed (is node on PATH?)"; return 1; }
eval "$_lb_resolved"

mkdir -p "$LOOP_PROFILE_DIR"
echo "▶ Loop instance '$LOOP_SITE'  ·  CDP :$LOOP_CDP_PORT  ·  profile $LOOP_PROFILE_DIR"
if [ "${LOOP_RUNNING:-0}" = "1" ]; then
  echo "✓ already running on :$LOOP_CDP_PORT — reusing it (login preserved, no relaunch)."
else
  # ALWAYS the repo's own CLI — never a PATH `loop`: that can be a stale installed-app
  # shim (a broken bundled CLI crashed exactly here once). We know the repo root; use it.
  node "$_lb_root/cli.mjs" start
fi
echo "✓ this terminal now drives the '$LOOP_SITE' browser — its login persists in its own profile."
unset _lb_sourced _lb_site _lb_self _lb_root _lb_resolved LOOP_SITE LOOP_RUNNING
