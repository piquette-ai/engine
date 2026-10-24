# Running `spf watch` as a factory: upgrade and reload scripts

A "factory" is a machine that keeps one or more `spf watch` daemons running, each in a GNU `screen` session named `spf-<name>`. The scripts in `scripts/factory/` upgrade spf, pick up repo changes, and (re)start those daemons. They are machine-agnostic: the list of repos comes from the machine, not from the scripts.

Requires zsh, GNU `screen`, `git`, and `spf` on the login-shell PATH.

## Setup

Each daemon is a directory `~/.spf/watch/<name>/`:

| File | Required | Meaning |
| --- | --- | --- |
| `repo_dir` | yes | Absolute path to the checkout `spf watch` runs in (first line is used) |
| `restart.env` | no | Shell env sourced before each launch (created empty if missing) |

```sh
mkdir -p ~/.spf/watch/core
echo /Users/me/dev/core > ~/.spf/watch/core/repo_dir
```

Optional shared env (tokens and so on) goes in `~/.spf/env`; it is sourced after `restart.env` when present. A directory without a valid `repo_dir` is skipped, and each skip is logged. Daemon names may only use letters, digits, `.`, `_` and `-`. If no daemon is configured the scripts refuse to run.

**Existing factory?** Before the first `upgrade.sh` or `reload.sh`, create a `repo_dir` for every `spf watch` already running on the machine. The drain only touches daemons whose working directory matches a configured `repo_dir`, and refuses to start if any running `spf watch` does not match one (it could not bring that daemon back). spf also creates its own folders under `~/.spf/watch/<repo>/`; those are skipped unless they hold a `repo_dir`.

Set `SPF_WATCH_HOME` to use a root other than `~/.spf/watch`.

## Usage

Run from a checkout of this repo, or copy `scripts/factory/` to the machine (the four files must stay together).

```sh
scripts/factory/upgrade.sh [--dry-run] <spf version>   # drain, npm i -g @gr8ful/spf@<version>, pull, relaunch
scripts/factory/reload.sh  [--dry-run]                 # drain, pull, relaunch (no install)
scripts/factory/relaunch.sh [--dry-run] [name]         # just (re)start one or all daemons
```

`upgrade.sh` and `reload.sh`:

1. Send SIGINT to each running `spf watch` that belongs to a configured daemon and wait for it to exit, so in-flight runs finish. The log notes progress every few minutes while waiting.
2. Wait for any one-off `spf watch --once` to finish (see the lock trap below).
3. (`upgrade.sh` only) Install the requested version once. If the install fails it is logged and the daemons relaunch on the old version.
4. `git pull --ff-only` each checkout. A failed pull is logged and the current checkout is kept.
5. Relaunch each daemon in `screen -dmS spf-<name>`, then list the running daemons.

A daemon is skipped on relaunch only if an `spf watch` is actually running in its `repo_dir`. If a leftover screen session named `spf-<name>` exists with no daemon in it, dead sockets are wiped and the daemon starts under `spf-<name>-<time>`. Only one factory script runs at a time (lock in `~/.spf/watch/.factory.lock`).

The scripts exit non-zero if the install or a pull failed, a relaunch failed, or a configured daemon is not running at the end.

`--dry-run` prints what would happen (drain targets, pulls, screen commands) without stopping, installing, pulling or launching anything.

## Logs

- Per-run log: `~/.spf/watch/upgrade-<version>.log`, `reload-<timestamp>.log` or `relaunch-<timestamp>.log` . The terminal only gets the log path and a `tail -f` hint; output goes to the file so the run survives a closed terminal or dropped ssh session (HUP and PIPE are ignored).
- Daemon output: `~/.spf/watch/<name>/watch.log`.

## The one-off lock trap

`spf watch --once` takes the same per-repo lock as the daemon. A daemon relaunched while a one-off run still holds it will not start cleanly, so the scripts wait for `spf watch --once` processes to exit before installing or relaunching. If a one-off run hangs, the script waits indefinitely; check `pgrep -fl "spf watch --once"` and stop it.
