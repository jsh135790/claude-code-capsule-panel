# capsule-panel

A live usage dashboard for Claude Code — context breakdown, cache hits, rate-limit forecast, cost and activity, in a Catppuccin capsule-style side pane.

English | [简体中文](README.zh-CN.md)

![capsule-panel](docs/screenshot.png)

## What it shows

A side pane, one page, with each section hiding itself while it has nothing to say:

- **CONTEXT**: how full the context window is, split by category, with a marker where auto-compact kicks in
- **CACHE / TOKENS / COST**: prompt-cache hit rate, tokens in and out, session cost and $/hour
- **LIMITS**: each plan rate-limit window with its reset countdown, and a forecast of whether you'll hit it before it resets. Rate limits are only reported on a Claude subscription; without them this section hides and COST shows tokens per hour instead. When the forecast says a window will run out before its reset, a toast says so once per window
- **ACTIVITY**: a tok/s sparkline, the last five tool calls with their time and outcome, and running subagents
- **GIT**: branch, commits ahead/behind, lines added/removed and changed files
- **TODO**: the current todo list's progress and the step under way

Plus a one-line band above the prompt while Claude is working: a capsule naming the phase or the tool, what it is doing and for how long, then tok/s, running subagents and the turn's time. It takes no space when idle.

When a turn completes, a short tone plays where the platform has a player (see Options).

## Requirements

- Claude Code 2.1.317 or later, in the terminal or in Claude Desktop
- In the terminal, a [Nerd Font](https://www.nerdfonts.com/) for the icons (developed with MartianMono Nerd Font in Windows Terminal). Without one, set `icons` to `unicode` (see Options) and the pane draws plain symbols instead
- Claude Desktop needs nothing: it draws the icons and capsules as vector shapes automatically

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install capsule-panel --marketplace jsh135790/claude-code-capsule-panel
```

Answer `y` to add the marketplace, then press Enter to install for your user. It's active right away.

In Claude Desktop: click + next to the prompt box, then Plugins, add the marketplace `jsh135790/claude-code-capsule-panel`, then add the plugin.

## Usage

- In the terminal, the pane opens by itself when the window is at least 144 columns wide
- In Claude Desktop, the pane opens by itself when a conversation starts
- `/panel` opens or closes it at any width
- The button in the pane hides or shows the band above the prompt

## Options

Set them in `/config` under the plugin's name, or in `~/.claude/settings.json` under `pluginConfigs`:

| Option | Values | Default | What it does |
| --- | --- | --- | --- |
| `icons` | `auto`, `nerd`, `unicode` | `auto` | `auto` draws Nerd Font glyphs in the terminal and vector icons in Claude Desktop; `nerd` forces the glyphs everywhere, `unicode` plain symbols in the terminal |
| `sound` | `true`, `false` | `true` | Plays a short tone when a turn completes. macOS plays it with `afplay`; a Windows or Linux terminal has no player and stays silent; Claude Desktop depends on the app |

## Optional: matching status line

`extras/statusline/statusline-command.sh` is a status line in the same capsule style: model and effort, directory, git branch, context %, cost and vim mode. It needs `bash` and `jq`; `git` is optional. It respects `NO_COLOR`.

Copy it to `~/.claude/statusline-command.sh` and add this to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "bash \"$HOME/.claude/statusline-command.sh\""
}
```

## Development

```
claude --plugin-dir /path/to/claude-code-capsule-panel
claude plugin validate .
claude plugin test .
npx -y -p typescript@5 tsc -p .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes the first time it loads the plugin, so run the plugin once before type-checking. The declarations it lays down are the build's own; type-check against a build that is 2.1.317 or later.

## License

[MIT](LICENSE)
