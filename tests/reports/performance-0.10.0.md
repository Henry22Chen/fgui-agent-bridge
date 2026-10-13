# 0.10.0 批量编辑实施与验收报告

分支：`feat/batch-editing-performance`，基线 `fd166d3`。方案见 `docs/performance-plan.md:1`，调用计划见 `.agents/skills/fgui-agent-bridge/references/editing-plans.md:1`。

本报告记录独立 worktree 的实现与验收结果；Git 提交、推送及各机器部署状态需分别核对，不由夹具测试代表。验收未修改/保存/发布业务 UI。协议仍为 2.0，新增 7 个 MCP 工具，总数 80。

## 实现

1. 跨对象批量编辑：一条队列请求执行最多 200 个白名单操作，绑定目标文档和读取时的 revision；创建由 Editor 分配 ID，支持 ref 引用后续操作。单步保存、资源导入、发布、任意脚本及文档切换禁止。
2. 操作回执：按 Editor 进程实例写入 running/succeeded/failed 回执；相同操作键和参数不重复执行，不同参数复用键拒绝。失败停止并报告已完成项，不假装原子回滚；保存阶段错误明确区分 saved/persisted。
3. 精简读取：按目标/字段批量读取并返回 revision；验证 expected 时默认不返回整树。批量默认摘要，verbose 才展开各步结果。
4. 集中预览：一次请求验证并截取 1..12 个设计态，每次从原控制器基线开始，finally 恢复并比较完整快照；返回一张编号联系图，标签与原图路径保留在元数据中。
5. XML 交接：干净文档生成一次性令牌；外部写入后检查相同原生文档及完整内存快照，拒绝陌生修改、错误 XML 根节点和重复/空控件 ID，再重载。不会自动写 XML、保存或发布。
6. 计时与规划：有界记录 readiness、请求等待、Editor 排队/执行时间及字节；PNG alpha 可见边界、可选 PSD 图层/文字只读检查。Skill 先规划、批量执行、集中校准，保持原有章节结构。
7. 同步修复：最终回归发现同长度快速改写可能命中 filecmp 的 mtime 缓存，改为流式内容比较，并加入相同大小/mtime 的确定性回归，避免新插件被误判为 unchanged。

## 性能证据

环境：Windows、FairyGUI Editor 6.1.4，直接本机 MCP stdio，专用 Capabilities 夹具；20 个原生 Text 对象，每个修改 x/y/width/height。

| 项目 | 逐项方式 | 批量方式 |
|---|---:|---:|
| 队列请求数 | 80 | 1 |
| 实测耗时 | 16.228 秒 | 0.259 秒 |
| 布局结果 | 20 个对象逐字段回读 | 与逐项结果一致 |
| 批量响应大小 | verbose 11,860 字节 | 默认摘要 600 字节 |

请求数减少 98.75%，摘要字节减少约 94.9%。这些是本机夹具测量，未包含 Codex 调用端分发、模型推理/生成或整页美术制作时间；不能承诺整页制作按相同倍数提速，也不把响应字节直接换算为 token 降幅。

本次批量内部计时：readiness 2.793 ms、Editor 队列等待 186 ms、执行 40 ms，客户端往返约 257 ms。轮询间隔和进程复用安全检查保持原样。

可机读数据：`tests/reports/performance-0.10.0.json:1`；状态联系图：`tests/reports/performance-states.png`（1=Idle，2=Active）。联系图已实际观察，两种文字状态不同；控制器完整快照恢复一致。

## 验证

- TypeScript 5.4.5 编译通过；编译后的 main.js 与 main.ts 一起保留。
- Python compileall、CLI/MCP Windows 入口帮助通过；uv.lock 对应 0.10.0，Pillow 默认安装，PSD 依赖为可选 design extra。
- 81 项回归通过，包括旧进程复用/队列隔离和新批量边界、失败语义、联系图、透明边界、同步缓存回归。
- 22 项真实 Editor 用例通过：原生 ID、ref、重复提交、操作键复用拒绝、陈旧计划拒绝、部分失败回执、一次保存/XML 回读、状态恢复、外部修改重载及陌生内存/重复 ID 拒绝等。
- 一条跨类型批量中的 16 个原生操作通过：分组及成员 ref、关系添加/移除、Loader、按钮绑定、List/ScrollPane、文本、创建/切页控制器、资源实例插入/修改/移除，并保存回读。
- 4 项最终关闭重开检查通过：20 个 ID/几何、外部 XML 几何持久化、旧实例回执隔离、只读检查后文档干净。
- 素材脚本实际读取 64×64 PNG 的可见边界及一份 1080×1920 PSD 的 149 个图层；未导出或修改原设计资源。
- 最终 git diff --check 通过。测试 Editor 在核对原生 exe、PID、启动时间及目标项目后关闭，未保留额外测试窗口。

未进行业务界面整页还原、运行预览点击/滚动、Unity 编译或游戏运行验证。本轮没有改 C#、导出 UI 包或生成代码。

## 使用边界

- 批量不是完整事务，dry_run 仅检查结构、作用域和引用；动态原生约束执行时检查。失败或超时先查询回执，unknown/running 不证明可以安全重试。
- 回执只限同一 Editor 进程实例；重启后的 unknown 已实测。revision 在原生异步加载/布局改变后会失效，需重新读取，不降低校验以强行执行。
- XML 交接不能覆盖新的 Editor 内存修改；显式 allow_unchanged_dirty 也必须完整快照不变。
- 截图仅支持普通设计编辑态的指定根控制器恢复，不承诺恢复运行预览中的业务副作用。缺图/恢复失败必须人工核对，图片生成不自动等于视觉验收。
- Bridge 内部计时不包含调用端分发或模型耗时。业务会话使用新工具前，需要同步 0.10.0 插件、更新共享 Python 环境并重新连接 MCP。

## 影响文件（相对 Bridge 仓库根目录）

| 文件与位置 | 作用 |
|---|---|
| `plugin/main.ts:3933` | revision、定向读取、批量回执、状态截图及 XML 交接；响应 envelope 计时 |
| `plugin/main.js:1` | 编译运行文件 |
| `plugin/package.json:5`、`pyproject.toml:7`、`src/fairygui_agent/__init__.py:3`、`uv.lock:1` | 版本与图片/可选设计依赖 |
| `src/fairygui_agent/bridge_client.py:204` | 有界计时记录及按能力拒绝旧插件 |
| `src/fairygui_agent/mcp_server.py:703` | 7 个 MCP 工具、精简验证及默认批量工作流 |
| `src/fairygui_agent/performance.py:1` | 计划校验、MCP 失败标志及有界联系图 |
| `src/fairygui_agent/cli.py:357` | 批量计划文件、查询、预览、XML 交接及诊断命令 |
| `scripts/inspect_design_assets.py:1` | PNG alpha 边界、PSD 结构只读工具 |
| `scripts/sync_to_project.py:237` | 避免 mtime 缓存漏同步 |
| `README.md:301` | 总能力表和批量/XML 工作流 |
| `.agents/skills/fgui-agent-bridge/SKILL.md:45` | 优先定向读取、批量计划和集中校准 |
| `.agents/skills/fgui-agent-bridge/references/current-capabilities.md:35` | 80 工具签名、边界与 CLI 映射 |
| `.agents/skills/fgui-agent-bridge/references/editing-plans.md:1` | 参数白名单和调用示例 |
| `docs/performance-plan.md:1` | 具体方案和验收标准 |
| `tests/test_performance.py:1`、`tests/performance_host_harness.cjs:1` | 回执、范围、状态恢复、交接及截图回归 |
| `tests/test_animation_surfaces.py:144`、`tests/test_sync_and_update.py:23` | 工具数量及快速同尺寸改写回归 |
| `tests/live_performance_validation.py:1`、`tests/live_batch_surfaces.py:1` | 硬性限制隔离夹具的真实 Editor 验证 |
| `tests/fixtures/editing/Capabilities.fairy:1`、`tests/fixtures/editing/README.md:1` | 隔离工程标识与说明 |
| `tests/fixtures/editing/assets/Probe/package.xml:1`、`Root.xml:1`、`Child.xml:1`、`TabButton.xml:1`（后三者同目录） | 最小资源/组件夹具 |
| `tests/fixtures/editing/assets/Probe/Panel.png` | 合成图片夹具，二进制文件 |
| `tests/reports/performance-0.10.0.md:1`、`tests/reports/performance-0.10.0.json:1`、`tests/reports/performance-states.png` | 本报告、便携验证数据和联系图（PNG 为二进制） |
