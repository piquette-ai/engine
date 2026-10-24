# Shared helpers for the spf factory scripts (upgrade.sh, reload.sh, relaunch.sh).
# Sourced, not executed. zsh only.
#
# A "daemon" is a directory ~/.spf/watch/<name>/ containing:
#   repo_dir     (required) absolute path to the checkout `spf watch` runs in
#   restart.env  (optional) shell env sourced before each (re)launch
# Override the root with SPF_WATCH_HOME (used by the dry-run checks).

SPF_WATCH_HOME=${SPF_WATCH_HOME:-$HOME/.spf/watch}
DRY_RUN=0
FAILED=0
typeset -a DAEMON_NAMES SKIP_MSGS MANAGED STRAY
typeset -A DAEMON_DIRS

log() { print -r -- "[$SCRIPT_TAG] $(date) $*"; }

# run <cmd...>: execute, or just print under --dry-run.
run() {
  if (( DRY_RUN )); then
    print -r -- "[$SCRIPT_TAG] [dry-run] would run: ${(j: :)${(q)@}}"
  else
    "$@"
  fi
}

# setup_log <label>: send everything to a per-run log in the watch home.
# Output goes to the file only (the terminal gets the path and a tail hint), so
# the script keeps running if the caller's terminal or ssh session goes away.
# HUP and PIPE are ignored for the same reason: a drain can last hours and the
# daemons must not be left down because the caller disconnected.
setup_log() {
  local logfile=$SPF_WATCH_HOME/$1.log m
  if (( DRY_RUN )); then
    print -r -- "[$SCRIPT_TAG] [dry-run] would log to ${(q)logfile}"
    return
  fi
  mkdir -p "$SPF_WATCH_HOME" || exit 1
  print -r -- "[$SCRIPT_TAG] logging to $logfile (follow with: tail -f ${(q)logfile})"
  trap '' HUP PIPE
  exec >>"$logfile" 2>&1
  # Replay what load_daemons said before the log existed.
  for m in $SKIP_MSGS; do print -r -- "$m"; done
}

# acquire_lock: one upgrade/reload/relaunch at a time per machine.
acquire_lock() {
  (( DRY_RUN )) && return 0
  local lock=$SPF_WATCH_HOME/.factory.lock other
  if ! mkdir "$lock" 2>/dev/null; then
    other=$(<"$lock/pid" 2>/dev/null)
    if [[ -n $other ]] && kill -0 "$other" 2>/dev/null; then
      log "another factory script is running (pid $other); refusing to start"
      exit 1
    fi
    log "removing stale lock from pid ${other:-unknown}"
    rm -rf "$lock"
    mkdir "$lock" || exit 1
  fi
  print -r -- $$ > "$lock/pid"
  trap 'rm -rf "'"$lock"'"' EXIT
}

# note <msg>: log now (terminal) and remember it for the per-run log.
note() {
  local m="[$SCRIPT_TAG] $(date) $*"
  SKIP_MSGS+=("$m")
  print -r -- "$m"
}

# load_daemons [only-name]: fill DAEMON_NAMES / DAEMON_DIRS from the machine.
# Exits non-zero when nothing is configured. Every folder that is skipped is
# reported, including those with no repo_dir.
load_daemons() {
  local only=${1:-} d name dir
  DAEMON_NAMES=()
  DAEMON_DIRS=()
  SKIP_MSGS=()
  for d in "$SPF_WATCH_HOME"/*(N/); do
    name=${d:t}
    [[ -n $only && $name != "$only" ]] && continue
    if [[ ! $name =~ '^[A-Za-z0-9._-]+$' ]]; then
      note "skipping '$name': daemon names may only use letters, digits, '.', '_' and '-'"
      continue
    fi
    if [[ ! -f $d/repo_dir ]]; then
      note "skipping $name: no repo_dir file in $d"
      continue
    fi
    dir=$(head -n 1 "$d/repo_dir" | tr -d '\r')
    if [[ $dir != /* || ! -d $dir ]]; then
      note "skipping $name: repo_dir '$dir' is not an existing absolute path"
      continue
    fi
    DAEMON_NAMES+=("$name")
    DAEMON_DIRS[$name]=$dir
  done
  if (( ${#DAEMON_NAMES} == 0 )); then
    if [[ -n $only ]]; then
      print -u2 -r -- "[$SCRIPT_TAG] no daemon '$only' configured: need $SPF_WATCH_HOME/$only/repo_dir (see docs/factory-ops.md)"
    else
      print -u2 -r -- "[$SCRIPT_TAG] no daemons configured: create $SPF_WATCH_HOME/<name>/repo_dir containing the checkout path (see docs/factory-ops.md)"
    fi
    exit 1
  fi
}

# pid_cwd <pid>: resolved working directory of a process (empty if unknown).
pid_cwd() {
  local c
  c=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
  [[ -n $c ]] && print -r -- ${c:A}
}

# classify_pids: split running `spf watch` pids into MANAGED (cwd is a
# configured repo_dir) and STRAY (anything else, including unknown cwd).
classify_pids() {
  local p cwd name match
  MANAGED=()
  STRAY=()
  for p in ${(f)"$(pgrep -f 'bin/spf watch$')"}; do
    cwd=$(pid_cwd "$p")
    match=
    if [[ -n $cwd ]]; then
      for name in $DAEMON_NAMES; do
        [[ ${DAEMON_DIRS[$name]:A} == $cwd ]] && match=1
      done
    fi
    if [[ -n $match ]]; then MANAGED+=("$p"); else STRAY+=("$p (cwd: ${cwd:-unknown})"); fi
  done
}

# daemon_running <name>: true if an `spf watch` is running in its repo_dir.
daemon_running() {
  local p cwd dir=${DAEMON_DIRS[$1]:A}
  for p in ${(f)"$(pgrep -f 'bin/spf watch$')"}; do
    cwd=$(pid_cwd "$p")
    [[ $cwd == $dir ]] && return 0
  done
  return 1
}

# wait_gone <pid...>: wait for pids to exit, logging every ~5 minutes.
wait_gone() {
  local p n
  for p in "$@"; do
    n=0
    while kill -0 "$p" 2>/dev/null; do
      sleep 15
      (( ++n % 20 == 0 )) && log "still waiting for pid $p ($(( n / 4 )) min)"
    done
    log "pid $p exited"
  done
}

# drain_daemons: SIGINT each running `spf watch` that belongs to a configured
# daemon and wait for it to exit, then wait out any one-off `spf watch --once`
# (it holds the same lock). Refuses if a running `spf watch` is not configured,
# because this script could not bring it back.
drain_daemons() {
  classify_pids
  if (( ${#STRAY} )); then
    log "refusing: running spf watch not matched to any configured repo_dir: ${(j:, :)STRAY}"
    log "add ~/.spf/watch/<name>/repo_dir for it (see docs/factory-ops.md), or stop it yourself"
    (( DRY_RUN )) && log "[dry-run] a real run would stop here" || exit 1
  fi
  if (( DRY_RUN )); then
    log "[dry-run] would drain pids: ${MANAGED[*]:-none} (SIGINT, wait for exit)"
    pgrep -f 'spf watch --once' >/dev/null &&
      log "[dry-run] a one-off 'spf watch --once' is running; would wait for it"
    return 0
  fi
  local p
  log "draining ${MANAGED[*]:-none}"
  for p in $MANAGED; do kill -INT "$p"; done
  wait_gone $MANAGED
  if pgrep -f 'spf watch --once' >/dev/null; then
    log "a one-off 'spf watch --once' still holds a lock; waiting"
    local n=0
    while pgrep -f 'spf watch --once' >/dev/null; do
      sleep 15
      (( ++n % 20 == 0 )) && log "still waiting for 'spf watch --once' ($(( n / 4 )) min)"
    done
  fi
}

# pull_all: ff-only pull every configured checkout; failure is logged, not fatal.
pull_all() {
  local name dir
  for name in $DAEMON_NAMES; do
    dir=$DAEMON_DIRS[$name]
    if (( DRY_RUN )); then
      log "[dry-run] would run: git -C ${(q)dir} pull --ff-only -q  ($name)"
    elif git -C "$dir" pull --ff-only -q; then
      log "$name at $(git -C "$dir" rev-parse --short HEAD)"
    else
      log "$name PULL FAILED; keeping the current checkout"
      FAILED=1
    fi
  done
}

# relaunch_one <name>: start spf watch for one daemon in a screen session.
# Skips only when an `spf watch` is actually running in that repo_dir. A leftover
# session of the same name (dead socket, or a shell that outlived its daemon) is
# wiped or avoided by picking a timestamped session name.
relaunch_one() {
  local name=$1 dir=$DAEMON_DIRS[$1]
  local wd=$SPF_WATCH_HOME/$name cmd sess=spf-$1
  cmd="cd ${(q)dir} && source ${(q)wd}/restart.env"
  cmd+=" && { [ ! -f \"\$HOME/.spf/env\" ] || source \"\$HOME/.spf/env\"; }"
  cmd+=" && exec spf watch >> ${(q)wd}/watch.log 2>&1"
  if (( DRY_RUN )); then
    log "[dry-run] would touch ${(q)wd}/restart.env if missing"
    log "[dry-run] would skip $name if an spf watch is already running in ${(q)dir}"
    log "[dry-run] would run: screen -dmS ${(q)sess} zsh -lc ${(q)cmd}"
    return 0
  fi
  if daemon_running "$name"; then
    log "$name already running in $dir; not relaunching"
    return 0
  fi
  [[ -f $wd/restart.env ]] || : > "$wd/restart.env"
  screen -wipe >/dev/null 2>&1
  if screen -ls 2>/dev/null | grep -qF -- ".$sess"$'\t'; then
    sess=$sess-$(date +%H%M%S)
    log "screen session spf-$name exists but no daemon runs in it; using $sess"
  fi
  if screen -dmS "$sess" zsh -lc "$cmd"; then
    log "relaunched $name in screen $sess"
  else
    log "RELAUNCH FAILED for $name"
    FAILED=1
  fi
}

relaunch_all() {
  local name
  for name in $DAEMON_NAMES; do relaunch_one "$name"; done
}

# final_listing: show what is running and flag any configured daemon that is not.
final_listing() {
  local name
  if (( DRY_RUN )); then
    log "[dry-run] would sleep 20 and list: pgrep -fl 'bin/spf watch\$'"
    return 0
  fi
  sleep 20
  pgrep -fl 'bin/spf watch$'
  for name in $DAEMON_NAMES; do
    daemon_running "$name" || { log "NOT RUNNING after relaunch: $name (see $SPF_WATCH_HOME/$name/watch.log)"; FAILED=1; }
  done
}

# finish: log the outcome and exit non-zero if anything went wrong.
finish() {
  if (( FAILED )); then
    log "done WITH PROBLEMS (see lines above)"
    exit 1
  fi
  log "done"
}

# parse_dry_run <args...>: sets DRY_RUN and leaves non-flag args in REST.
typeset -a REST
parse_dry_run() {
  local a
  REST=()
  for a in "$@"; do
    case $a in
      --dry-run) DRY_RUN=1 ;;
      -h|--help) print -r -- "$USAGE"; exit 0 ;;
      -*) print -u2 -r -- "unknown option: $a"; print -u2 -r -- "$USAGE"; exit 2 ;;
      *) REST+=("$a") ;;
    esac
  done
}
