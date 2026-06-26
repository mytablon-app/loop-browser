#!/usr/bin/env bash
# Point THIS terminal at ONE Loop Browser instance (one account/site) and start it.
# MUST be sourced so the env sticks in your shell:
#   source scripts/instance.sh <site> [port]
#     source scripts/instance.sh whatsapp     # CDP :9223, profile ~/.loop-profiles/whatsapp
#     source scripts/instance.sh linkedin     # CDP :9222, profile ~/.loop-profiles/linkedin
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
_lb_profile=""
case "$_lb_site" in
  whatsapp|wa) _lb_port="${2:-9223}"; _lb_label="wa";;
  # LinkedIn's login lives in the DEFAULT Electron userData (that's where it was
  # first signed in), NOT ~/.loop-profiles/linkedin. Pin it there so sourcing this
  # never lands on an empty, logged-out profile. (macOS userData path.)
  linkedin|li) _lb_port="${2:-9222}"; _lb_label="li"; _lb_profile="$HOME/Library/Application Support/Loop Browser";;
  *)           _lb_port="${2:-9224}"; _lb_label="$_lb_site";;
esac
export LOOP_CDP_PORT="$_lb_port"
export LOOP_PROFILE_DIR="${_lb_profile:-${LOOP_PROFILE_BASE:-$HOME/.loop-profiles}/$_lb_site}"
# Label the Claude Code ctx strip for this terminal (read by ~/.claude/statusline-command.sh).
export LOOP_LABEL="loop-browser-$_lb_label"
mkdir -p "$LOOP_PROFILE_DIR"
echo "▶ Loop instance '$_lb_site'  ·  CDP :$LOOP_CDP_PORT  ·  profile $LOOP_PROFILE_DIR"
if command -v loop >/dev/null 2>&1; then loop start
else echo "  (run 'npm link' once so 'loop' is on PATH, then: loop start)"; fi
echo "✓ this terminal now drives the '$_lb_site' browser — log in once in its window, then cook."
unset _lb_sourced _lb_site _lb_port _lb_label
