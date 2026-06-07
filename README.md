# pi-clockwork

[![npm version](https://img.shields.io/npm/v/pi-clockwork.svg)](https://www.npmjs.com/package/pi-clockwork)
[![GitHub release](https://img.shields.io/github/v/release/brunoorsolon/pi-clockwork)](https://github.com/brunoorsolon/pi-clockwork/releases)

`pi-clockwork` is a Pi extension for durable recurring work. It can run an agent prompt, compact context, start a new session, execute a shell command, or call a slash command on an exact interval.

Terminology: Clockwork manages **jobs**. Each job has a schedule (interval, next run, max runs), and each firing creates a **run**.

## Install

```bash
pi install npm:pi-clockwork@0.1.0
```

For a one-off smoke run without installing:

```bash
pi -e npm:pi-clockwork@0.1.0
```

For local development from a checkout:

```bash
pi install ./pi-clockwork
pi -e ./extensions/pi-clockwork.ts
```

## Quick start

Run a prompt every 10 minutes, up to 5 times, then compact and start a new session:

```text
/clockwork add --name gh-issues --every 10m --times 5 \
  --prompt "Check my GitHub repository for open issues. Pick one and start. Once done, save a report named report-issue-<issue-number>-{{date:yyyy-mm-dd_HH-MM-ss}}." \
  --then compact \
  --then new
```

Open the manager:

```text
/clockwork
```

Short alias:

```text
/cw
```

## Commands

```text
/clockwork add --every <interval> --prompt <text> [--times N] [--name name]
/clockwork add --every 30s --shell -- gh issue list
/clockwork list
/clockwork status
/clockwork pause <id>
/clockwork resume <id>
/clockwork stop <id|all>
/clockwork delete <id|all>
/clockwork run-now <id>
/clockwork inspect <id>
/cw list
```

Intervals are exact timer intervals, not cron: `1s`, `30 sec`, `10m`, `2h`, `every 10 minutes`.

## Action chain syntax

Supported `--then` actions:

```text
--then compact
--then new
--then slash /some-command
--then shell -- echo done
```

Built-in compaction and new-session behavior use typed Pi APIs. Generic slash commands are best-effort and intended for third-party commands.

## TUI manager keys

- `↑`/`↓` or `k`/`j`: select job
- `r`: run now
- `p`: pause/resume
- `s`: stop
- `d`: delete
- `i`: inspect
- `q`/`Esc`: close

The extension also shows an ambient status/widget with active jobs, next run, run counts, lock state, and skipped ticks.

## Agent tools

The agent can use:

- `ClockworkCreate`
- `ClockworkList`
- `ClockworkControl`

Tool guidance tells the agent to use pi-clockwork instead of raw Bash `sleep` or `while` loops.

## Persistence

Default store:

```text
.pi/clockwork/jobs.json
```

Override:

```bash
PI_CLOCKWORK_STORE=/path/to/jobs.json pi
```

Jobs are workspace-scoped by default, so they survive `/new`, `/reload`, and Pi restarts. An owner lease prevents two Pi processes in the same workspace from firing the same store at once.

## Safety notes

- Default overlap policy is `drop`: if a previous run is still active, the tick is skipped.
- `coalesce` and `queueOne` are available through tools/parser support, but there is no unbounded backlog.
- Use `--times` / `maxRuns` for polling tasks.
- Shell actions run with extension process permissions. They have timeouts and output caps, but should still be configured intentionally.
- Use typed `compact` and `newSession` actions instead of sending `/compact` or `/new` as generic slash actions.
