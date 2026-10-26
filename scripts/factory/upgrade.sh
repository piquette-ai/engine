#!/bin/zsh -l
# Drain the piquette watch daemons, install a new piquette version, pull each repo, relaunch.
SCRIPT_TAG=upgrade
USAGE='Usage: upgrade.sh [--dry-run] <piquette version>'
set -u
source "${0:A:h}/lib.sh"
parse_dry_run "$@"
(( ${#REST} == 1 )) || { print -u2 -r -- "$USAGE"; exit 2; }
V=${REST[1]}
load_daemons
setup_log "upgrade-$V"
acquire_lock
log "start; piquette $(piquette version 2>/dev/null) -> $V; daemons: ${DAEMON_NAMES[*]}"
drain_daemons
if ! run npm i -g "@piquette/engine@$V"; then
  log "INSTALL FAILED; relaunching on the old version"
  FAILED=1
fi
(( DRY_RUN )) || log "now $(piquette version)"
pull_all
relaunch_all
final_listing
finish
