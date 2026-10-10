# capsule-panel

Claude Code 实时用量面板：上下文构成、缓存命中、限额预测、花费与活动，Catppuccin 胶囊风侧边栏。

[English](README.md) | 简体中文

![capsule-panel](docs/screenshot.png)

## 面板内容

侧边栏只有一页，按区块排列，暂时没有数据的区块会自动隐藏。

- **CONTEXT**：上下文窗口占用，按类别分段显示，并标出自动压缩的触发位置
- **CACHE / TOKENS / COST**：提示缓存命中率、输入输出 token、本次会话花费和每小时花费
- **LIMITS**：每个限额窗口的重置倒计时，以及按当前消耗速度预测会不会在重置前用完。只有 Claude 订阅账号才会返回限额数据，没有的时候这一块隐藏，COST 改为显示每小时 token 数
- **ACTIVITY**：tok/s 火花线、最近 5 次工具调用（耗时和结果），以及正在运行的子代理
- **GIT**：当前分支、领先/落后的提交数、增删行数和改动文件数
- **TODO**：当前 todo 列表的进度和正在进行的步骤

Claude 工作时，输入框上方还会多出一行横幅，显示当前工具、已用时间和 tok/s。空闲时这一行不占位置。

## 环境要求

- Claude Code 2.1.293 或更新版本（开发和测试都在这个版本上进行），终端和 Claude Desktop 都能用
- 终端使用 [Nerd Font](https://www.nerdfonts.com/) 字体，否则图标无法显示（开发环境为 Windows Terminal + MartianMono Nerd Font）

## 安装

在 Claude Code 终端会话的输入框里输入：

```
/plugin install capsule-panel --marketplace jsh135790/claude-code-capsule-panel
```

提示添加 marketplace 时输入 `y`，再按回车安装到用户范围，装完立即生效。

## 使用

- 在终端里，窗口宽度达到 144 列时面板会自动打开
- 在 Claude Desktop 里，开启对话后面板会自动打开
- 任何宽度下都可以用 `/panel` 打开或关闭面板
- 面板里的按钮可以隐藏或显示输入框上方的横幅

## 可选：同风格 statusline

`extras/statusline/statusline-command.sh` 是一个同样胶囊风格的状态栏，显示模型和 effort、目录、Git 分支、上下文百分比、花费和 vim 模式。依赖 `bash` 和 `jq`，`git` 可选，支持 `NO_COLOR`。

把它复制到 `~/.claude/statusline-command.sh`，再在 `~/.claude/settings.json` 里加上：

```json
"statusLine": {
  "type": "command",
  "command": "bash \"$HOME/.claude/statusline-command.sh\""
}
```

## 已知问题

- 在 Claude Desktop 里，侧边栏面板和输入框上方横幅中的 Nerd Font 图标无法正确显示

## 开发

```
claude --plugin-dir /path/to/claude-code-capsule-panel
claude plugin validate .
claude plugin test .
npx -y -p typescript@5 tsc -p .
```

`tsconfig.json` 继承自 `.claude-plugin/types/tsconfig.json`，这个文件要等 Claude Code 第一次加载插件时才会生成，所以做类型检查之前先把插件跑一次。

## 许可证

[MIT](LICENSE)
