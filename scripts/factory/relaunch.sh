#!/bin/zsh -l
# (Re)start one or all spf watch daemons without draining or pulling.
SCRIPT_TAG=relaunch
USAGE='Usage: relaunch.sh [--dry-run] [name]'
set -u
source "${0:A:h}/lib.sh"
parse_dry_run "$@"
(( ${#REST} <= 1 )) || { print -u2 -r -- "$USAGE"; exit 2; }
load_daemons "${REST[1]:-}"
setup_log "relaunch-$(date +%Y%m%d-%H%M%S)"
acquire_lock
relaunch_all
final_listing
finish
