# capsule-panel

Claude Code 实时用量面板：上下文构成、缓存命中、限额预测、花费与活动，Catppuccin 胶囊风侧边栏。

[English](README.md) | 简体中文

![capsule-panel](docs/screenshot.png)

## 面板内容

侧边栏只有一页，按区块排列，暂时没有数据的区块会自动隐藏。

- **标题行**：当前用的模型和 effort，以及 Claude 是否在工作
- **CONTEXT**：上下文窗口占用，按类别分段显示，并标出自动压缩的触发位置。下面一行按最近几轮的增长速度估算还剩几轮触发自动压缩；Claude 空闲时旁边有一个 **compact now** 按钮（3 秒内连按两次才会压缩），压缩之后这一行会显示上下文从多少压到了多少
- **CACHE / TOKENS / COST**：提示缓存命中率和缓存还能保温多久（最后一分钟按秒倒数，过期后显示 `cold`）、输入输出 token、本次会话花费和每小时花费
- **SPEND**：这台机器上所有 Claude Code 会话今天和本周（从周一算起）一共花了多少，后面是最近 7 天每天一根柱子。数据是 Claude Code 报告的会话花费（按 API 价格估算），从 0.4.0 开始记在插件自己的存储里
- **LIMITS**：每个限额窗口的重置倒计时，以及按当前消耗速度预测会不会在重置前用完。只有 Claude 订阅账号才会返回限额数据，没有的时候这一块隐藏，COST 改为显示每小时 token 数。预测到某个窗口会在重置前用完时，会弹一次 toast 提醒，每个窗口只提醒一次
- **ACTIVITY**：tok/s 火花线、最近 5 次工具调用（耗时和结果），以及正在运行的子代理
- **GIT**：当前分支、领先/落后的提交数、增删行数，以及本次会话里 Claude 改过的文件，最新的 5 个排在前面并标出增删行数（未跟踪的新文件标 `new`）。不在 Git 仓库里时也会列出改过的文件
- **TODO**：当前 todo 列表的进度和正在进行的步骤
- **底栏**：设置按钮，以及 Claude Code 和 Claude Desktop 的版本号

Claude 工作时，新出现的活动条目会先亮一下，一秒内褪回原色；达到 80% 的数字（上下文、限额）会红色呼吸闪动。空闲时面板保持静止。

Claude 工作时，输入框上方还会多出一行横幅：标明当前阶段或工具的胶囊、正在做什么和用了多久，右边是 tok/s、运行中的子代理和本轮用时。空闲时这一行不占位置。

每轮对话结束时，在有播放器的平台上会响一声短提示音。一轮跑了一分钟以上时还会发一条通知：Windows 上是屏幕右下角的系统弹窗，其他平台走 Claude Code 自己的通知通道。这两项在终端里默认打开，在 Claude Desktop 里默认关闭，因为 Desktop 自己会提示（见「设置」）。

## 环境要求

- Claude Code 2.1.317 或更新版本，终端和 Claude Desktop 都能用
- 终端里建议使用 [Nerd Font](https://www.nerdfonts.com/) 字体显示图标（开发环境为 Windows Terminal + MartianMono Nerd Font）。没有的话在设置页把 Icons 改成 `unicode`，面板会改用普通 Unicode 符号
- Claude Desktop 不需要任何设置，图标和胶囊会自动画成矢量图形

## 安装

在 Claude Code 终端会话的输入框里输入：

```
/plugin install capsule-panel --marketplace jsh135790/claude-code-capsule-panel
```

提示添加 marketplace 时输入 `y`，再按回车安装到用户范围，装完立即生效。

在 Claude Desktop 里：点输入框旁边的 +，进 Plugins，添加 marketplace `jsh135790/claude-code-capsule-panel`，再添加插件。

## 使用

- 在终端里，窗口宽度达到 144 列时面板会自动打开
- 在 Claude Desktop 里，开启对话后面板会自动打开
- 任何宽度下都可以用 `/panel` 打开或关闭面板
- 面板底部的 **settings** 打开设置页，**← back** 回到仪表盘

## 设置

设置页列出所有选项，每项旁边的按钮点一下切换到下一个取值。终端和 Claude Desktop 各存一份，在哪一端改就只影响哪一端。设置存在插件自己的存储里，不在 `settings.json`，所以会重写 `settings.json` 的工具（比如供应商切换器）不会把它们冲掉。

| 设置 | 取值 | 终端 | Claude Desktop |
| --- | --- | --- | --- |
| Activity band（横幅） | on、off | on | on |
| Completion sound（完成提示音） | on、off | on | off |
| Long-turn notification（长任务通知） | on、off | on | off |
| after（通知门槛） | 30s、60s、120s、300s | 60s | 60s |
| Git & changed files（Git 与改动文件） | on、off | on | on |
| Cache countdown（缓存倒计时） | on、off | on | on |
| TTL（缓存时长） | auto、5m、1h | auto | auto |
| Today / week spend（今日/本周花费） | on、off | on | on |
| Compact forecast（压缩预测） | on、off | on | on |
| Versions（版本号） | on、off | on | on |
| Icons（仅终端） | nerd、unicode | nerd | — |

- **完成提示音**：macOS 用 `afplay` 播放；Windows 和 Linux 终端没有播放器，不会出声
- **TTL**：提示缓存能保留多久。`auto` 按 Claude Code 自己的规则判断：Claude 订阅账号是 1 小时，环境变量里设了 API key 或 token 时是 5 分钟，设了 `CLAUDE_CODE_PROMPT_CACHE_TTL` 或 `promptCacheTtl` 设置项时以它为准
- **Icons**：Claude Desktop 始终画矢量图标

0.4.0 以前，`icons` 和 `sound` 写在 `settings.json` 的 `pluginConfigs` 里，现在这两项已经不再读取，可以删掉。

## 可选：同风格 statusline

`extras/statusline/statusline-command.sh` 是一个同样胶囊风格的状态栏，显示模型和 effort、目录、Git 分支、上下文百分比、花费和 vim 模式。依赖 `bash` 和 `jq`，`git` 可选，支持 `NO_COLOR`。

把它复制到 `~/.claude/statusline-command.sh`，再在 `~/.claude/settings.json` 里加上：

```json
"statusLine": {
  "type": "command",
  "command": "bash \"$HOME/.claude/statusline-command.sh\""
}
```

## 开发

```
claude --plugin-dir /path/to/claude-code-capsule-panel
claude plugin validate .
claude plugin test .
npx -y -p typescript@5 tsc -p .
```

`tsconfig.json` 继承自 `.claude-plugin/types/tsconfig.json`，这个文件要等 Claude Code 第一次加载插件时才会生成，所以做类型检查之前先把插件跑一次。生成的类型声明是那个版本自己的，请用 2.1.317 或更新的版本做类型检查。

## 许可证

[MIT](LICENSE)
