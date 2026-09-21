# zcode-tui

![zcode TUI](screenshots/tui-main.png)

基于 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的 **TUI / CLI 定制版**：只关心终端里的 `zcode`——Agent CLI、全屏 TUI、子代理与多智能体编排。不涉及桌面端与 Web 端的定制开发（上游源码保留，构建链完整）。

相对上游新增 / 修改的内容：

- **AgentSwarm 工具**（对标 Kimi Code 的 swarm）：一次调用按 `prompt_template + items` 批量 fan-out 最多 128 个子代理，带断点续跑、每子代理超时、限速退避重试与启动节流
- **TUI swarm 显示**：工具调用行渲染为 `swarm (N subagents)` 分组卡片，附 items 预览与续跑计数；子代理沿用侧边栏 Subagents 区（点击可看 transcript）
- **Windows 中文乱码修复**：GBK 代码页的控制台在启动时自动切到 UTF-8（仅 win32 + TTY 生效，不影响其他平台）

## 快速开始

要求：Node `>= 24`，pnpm `>= 10`。

```bash
git clone git@github.com:Vlary/zcode-tui.git
cd zcode-tui
pnpm install                # .npmrc 的 node-linker=hoisted 是硬前提，勿改
cd apps/zcode-cli
npx turbo run build
node packages/cli/dist/zcode.cjs --version
```

日常使用建议加个别名（PowerShell profile）：

```powershell
function zcode { node E:\path\to\zcode-tui\apps\zcode-cli\packages\cli\dist\zcode.cjs @args }
```

不带参数启动即进入全屏 TUI；`zcode tui` 同义。首次使用先 `zcode login`：

- 国内 BigModel Coding Plan：`zcode login bigmodel`
- 国际站 Z.AI：`zcode login zai`

开发模式（源码热跑，免打包）：在 `apps/zcode-cli` 下执行 `pnpm cli:dev`。

## AgentSwarm 用法

适合「同类任务 × 大量不同输入」：一份模板，N 个子代理并行，结果聚合成单份简报返回。

```json
AgentSwarm({
  "description": "review core files",
  "prompt_template": "Review {{item}} for likely regressions and report findings.",
  "items": ["src/a.ts", "src/b.ts", "src/c.ts"]
})
```

- `items`：2~128 个（传 `resume_agent_ids` 时可少于 2 或省略）；模板必须含 `{{item}}` 占位符；展开后的 prompt 必须互不相同
- `resume_agent_ids`：`{ "agent_id": "continue" }` 形式，续跑失败或超时（`stop_reason="timeout"`）的子代理，可与新 items 混跑
- `subagent_type`：子代理类型，缺省 `general-purpose`

引擎行为（对齐同类 swarm 实现）：并发默认 8、启动节流前 5 个每 700ms 放行、限速错误（429 / rate limit / quota）指数退避重试（3s 起、2 倍率、60s 封顶、至多 3 次）、每子代理超时默认 10 分钟。

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ZCODE_SWARM_MAX_CONCURRENCY` | `8` | swarm 并发上限（最大 32） |
| `ZCODE_SWARM_TIMEOUT_MS` | `600000` | 单个子代理执行超时 |

与相邻工具的分工：少量异构任务用 `Agent`（一条消息多个调用并行）；需要类型化结果、循环、gate 的复杂编排用 `CreateWorkflow` 写 TS 脚本；大批量同构任务用 `AgentSwarm`。

## 目录结构（TUI/CLI 相关）

```
apps/zcode-cli/
  packages/cli        # CLI 入口：参数解析、登录、打包（单文件 zcode.cjs）
  packages/tui        # 全屏 TUI（OpenUI/React 终端渲染，含 swarm 投影）
  packages/core       # Agent 运行时与工具注册表（AgentSwarm 在 tool/handlers/）
  packages/bootstrap  # 启动装配、登录流程
  packages/contracts  # 跨包契约（AgentSwarm schema 在 tools/）
  packages/adapters   # OAuth / HTTP / 凭据存储适配
packages/             # 根工作区共享包（shared、provider、rpc 等，CLI 依赖闭包）
```

## 与上游的关系

Fork 自 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0），在其开源 commit 之上叠加本仓库的 TUI/CLI 定制。上游的 LICENSE、NOTICE、THIRD-PARTY-NOTICES 均完整保留。感谢 Z.ai 团队的开源工作。
