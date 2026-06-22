#!/usr/bin/env bash
# Point THIS terminal at ONE Loop Browser instance (one account/site) and start it.
# MUST be sourced so the env sticks in your shell:
#   source scripts/instance.sh <site> [port]
#     source scripts/instance.sh whatsapp     # CDP :9222, profile ~/.loop-profiles/whatsapp
#     source scripts/instance.sh linkedin     # CDP :9223, profile ~/.loop-profiles/linkedin
# After sourcing, every `loop` / cook command in this terminal drives that instance. Works in bash & zsh.
# Profiles live OUTSIDE the repo (login = your key): $HOME/.loop-profiles/<site> (override: LOOP_PROFILE_BASE).
# Crons do NOT use this — set LOOP_CDP_PORT / LOOP_PROFILE_DIR directly in the launchd plist.

# Refuse to run un-sourced (the exports would vanish the moment the script exits).
_lb_sourced=0
if [ -n "${ZSH_VERSION:-}" ]; then case "$ZSH_EVAL_CONTEXT" in *:file*) _lb_sourced=1;; esac
elif [ -n "${BASH_VERSION:-}" ]; then [ "${BASH_SOURCE[0]}" != "$0" ] && _lb_sourced=1; fi
if [ "$_lb_sourced" -ne 1 ]; then
  echo "✗ source it:  source scripts/instance.sh <site> [port]"; exit 1
fi

_lb_site="${1:-}"
[ -z "$_lb_site" ] && { echo "usage: source scripts/instance.sh <site> [port]"; return 1; }
case "$_lb_site" in
  whatsapp|wa) _lb_port="${2:-9222}";;
  linkedin|li) _lb_port="${2:-9223}";;
  *)           _lb_port="${2:-9224}";;
esac
export LOOP_CDP_PORT="$_lb_port"
export LOOP_PROFILE_DIR="${LOOP_PROFILE_BASE:-$HOME/.loop-profiles}/$_lb_site"
mkdir -p "$LOOP_PROFILE_DIR"
echo "▶ Loop instance '$_lb_site'  ·  CDP :$LOOP_CDP_PORT  ·  profile $LOOP_PROFILE_DIR"
if command -v loop >/dev/null 2>&1; then loop start
else echo "  (run 'npm link' once so 'loop' is on PATH, then: loop start)"; fi
echo "✓ this terminal now drives the '$_lb_site' browser — log in once in its window, then cook."
unset _lb_sourced _lb_site _lb_port
