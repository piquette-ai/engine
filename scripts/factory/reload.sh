#!/bin/zsh -l
# Drain the piquette watch daemons, pull each repo, relaunch (no npm install).
SCRIPT_TAG=reload
USAGE='Usage: reload.sh [--dry-run]'
set -u
source "${0:A:h}/lib.sh"
parse_dry_run "$@"
(( ${#REST} == 0 )) || { print -u2 -r -- "$USAGE"; exit 2; }
load_daemons
setup_log "reload-$(date +%Y%m%d-%H%M%S)"
acquire_lock
log "start; piquette $(piquette version 2>/dev/null); daemons: ${DAEMON_NAMES[*]}"
drain_daemons
pull_all
relaunch_all
final_listing
finish
