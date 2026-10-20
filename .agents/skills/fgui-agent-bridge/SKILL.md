---
name: fgui-agent-bridge
description: 当通过 MCP、CLI 或源码使用和维护独立 FGUI Agent Bridge 仓库时使用；包括连接 FairyGUI Editor、选择工程、读取/修改组件文档、保存/撤销、发布资源，以及新增或变更 Bridge Action、MCP 工具、CLI 参数、协议、安全边界、同步脚本和文档。
---

# FGUI Agent Bridge

## 目标与真源

本 Skill 面向独立 [Henry22Chen/fgui-agent-bridge](https://github.com/Henry22Chen/fgui-agent-bridge) 仓库。该仓库是 Bridge、MCP、CLI 和 Skill 的唯一开发真源，业务工程中的插件与 Skill 仅是同步快照。

- FairyGUI 插件源码：`plugin/main.ts`
- FairyGUI 运行文件：`plugin/main.js`；修改源码后必须重新编译并一起提交
- 插件包与最小宿主类型：`plugin/package.json`、`plugin/types/`
- Python/MCP/CLI 真源：`src/fairygui_agent/`
- 版本必须同步：`plugin/package.json`、`pyproject.toml`、`src/fairygui_agent/__init__.py`、`plugin/main.ts`、`plugin/main.js`
- 工程文档真源：`README.md`
- 按需查阅 [当前能力参考](references/current-capabilities.md)：工具签名、配置格式、CLI 映射及能力限制；具体编辑前读取相关条目。
- 业务工程同步入口：`scripts/sync_to_project.py`

若实现、README 和 Skill 不一致，先以代码和实际桥接响应核对，再在同一个改动中修正 README 与 Skill；不要凭旧摘要猜测 Action 或参数。

## 何时使用

- 使用 `fgui_*` MCP 工具或 `fgui-agent` CLI 操作 FairyGUI 组件。
- 查看包、资源、活动文档、对象树、对象 ID/路径、属性或撤销状态。
- 修改组件属性、插入/删除已有 `ui://` 资源、替换 Image/Loader 资源引用、读取或修改文本样式、验证文档结构与持久化、保存、放弃、撤销或重做。
- 发布当前包、指定包或全部包，或检查发布设置。
- 检查 Bridge/插件版本一致性，或从源仓库拉取最新代码并同步到目标工程。
- 修改插件、MCP、CLI、版本、协议、白名单、队列语义、同步脚本或 README。

## 使用工作流

### 0. 检查更新与同步（按需）

- 当用户要求“检查更新”、“拉取最新 Bridge 版本”，或 `fgui_status` 返回 `versionMatch: false` / 协议不兼容提示时：
  1. 先读取目标项目操作规范中的版本约定；固定标签的项目按安装章节检出指定标签并更新依赖，再同步插件与 Skill，省略 `--pull`，不自动改变项目约定。
  2. 仅未固定版本且明确跟踪开发分支的安装使用 `uv run python scripts/sync_to_project.py --pull --project PATH --skill-root PATH --apply`（或 `uv run fgui-agent update --pull --apply`）。
  3. 若插件更新，提醒用户在 FairyGUI Editor 中重新打开工程生效。

### 1. 连接与定位

1. 使用 `fgui_status` 核对工程路径属于当前副本，并查看在线状态、版本与心跳；它不会唤醒编辑器。仅有项目级 `FGUI_PROJECT_PATH` 不代表本机 MCP 已安装。
2. 定位失败或目标不符时，在当前副本查找 `.fairy` 并以绝对路径调用 `fgui_use_project`；多个候选且无法判断时询问用户。不要依赖 Bridge 递归查找 `UIProject`，其目录定位只检查直接 `.fairy` 和固定 `FairyGUI/FairyGUI.fairy`。
3. 需要唤醒或验证编辑器时调用 `fgui_ping`。Windows 复用必须核对插件当前工程目录、PID、进程启动时间和真实 exe，不凭窗口标题或启动参数判断。身份不明或目标工程存在多个实例时停止调用，要求用户确认目标实例；不要以重复 ping 尝试开窗。慢响应和超时不会启动新实例。
4. 不知道包名时先 `fgui_list_packages`；不知道资源时用 `fgui_list_items`。
5. 打开组件后先确认活动文档。整页布局先按设计稿整理坐标、字体和素材 alpha 可见边界（可用 `scripts/inspect_design_assets.py`），再用 `fgui_get_objects` 按对象/字段读取及取得 revision；仅在定位未知结构时读浅层对象树。修改优先使用稳定对象 ID，其次对象路径；只有名称唯一时才使用名称。

### 2. 创建、修改和保存

- 多对象计划优先 `fgui_apply_batch`，不要在 exec 内循环调用逐属性 MCP。明确 document_url、expected_revision 和 operation_key；默认摘要、不保存，创建 ref 后用 `$ref` 引用 Editor 分配的 ID。先检查 status，失败可部分执行；超时先 `fgui_get_batch_result`，unknown 不代表未执行。格式见[计划示例](references/editing-plans.md)。
- 按明确状态矩阵用 `fgui_capture_states` 一次截图并恢复指定控制器，联系图编号对应 metadata 标签；集中比较同画布/同状态，不能把生成图当视觉通过。
- 用户已明确授权 XML 编辑时，先 `fgui_begin_external_edit` 交接干净文档；外部写入后 `fgui_finish_external_edit` 仅在完整内存快照未变时重载。陌生 dirty 修改不得覆盖；不自动保存或发布。调用计时看 `fgui_diagnostics`，它不包含调用端或模型耗时。

- 新建组件使用 `fgui_create_component`，明确包、目录、名称、宽高、导出状态和冲突策略。
- 原生 Text/RichText/InputText/Loader/List/Group/Graph 使用 `fgui_create_object`，创建到当前文档根下。保存分组必须传 `group_member_ids`，分组边界由成员决定；默认不保存，无完整结构撤销。
- 图片、字体与声音导入使用绝对本地路径（`fgui_import_image` / `fgui_import_font` / `fgui_import_sound`）；`replace` 是磁盘覆盖，不能由文档放弃回滚。
- 动画编辑先用 `fgui_list_transitions` / `fgui_get_transition` 读取，再用 `fgui_upsert_transition` 进行整段声明式更新，或用关键帧原子工具局部修改；时间单位是 frame。全部原生 Transition 轨道均使用类型化 JSON。
- MovieClip 用 `fgui_create_movieclip` 的有序绝对图片路径创建，或通过 `fgui_update_movieclip` 更新帧与播放参数；帧由 FairyGUI 嵌入 `.jta`，不会自动生成逐帧图片 `ui://` 资源。已有 MovieClip 更新/替换可 Agent undo/redo，全新创建和删除不可逆。
- 用 `fgui_preview_animation` 播放、暂停、停止、跳帧或查询 Transition/MovieClip 预览状态。预览不保存，不能把预览状态描述为资源默认属性。
- 按钮状态图顺序固定为 `up/down/over/selectedOver/disabled/selectedDisabled`，非空值必须是工程内图片 `ui://` URL。
- 资源替换：替换显示对象引用的资源使用 `fgui_replace_object_resource`（当前仅支持 Image 与 Loader，不支持 Button 状态资源切换），支持传入 `expected_type` 校验并在 `--save` 时验证 Editor/XML 持久化。
- 文本样式：使用 `fgui_get_text_style` / `fgui_set_text_style` 编辑字体、颜色、描边/阴影开关及参数、粗体/斜体/下划线、UBB、文本、对齐、间距和自动尺寸。描边/阴影参数需启用对应效果；显式尺寸与自动尺寸冲突时先拒绝。批量几何属性用 `fgui_set_properties`，先设置 Pivot/尺寸、最后写坐标，避免 JSON 顺序引发位移；暂不支持自动 external reload。
- 图片缩放与九宫格用 `fgui_get_image_settings` / `fgui_set_image_settings`；这是影响所有引用的包级设置，`save=true` 保存整个所属包并回读，不等同于组件保存。
- 按钮与父控制器的原生绑定用 `fgui_get_button_binding` / `fgui_set_button_binding`；List 布局用 `fgui_get_list_settings` / `fgui_set_list_settings`，ScrollPane 分页和控制器用 `fgui_get_scroll_settings` / `fgui_set_scroll_settings`。二维 Loader 布局用 `fgui_get_loader` / `fgui_set_loader`。
- 分组成员用 `fgui_get_group` / `fgui_set_group`，空 ID 解除分组；布局关系用 `fgui_get_relations` / `fgui_add_relation` / `fgui_remove_relation`。只改当前文档直属对象及同层/父级引用，拒绝循环和继承只读关系；默认不保存，`save=true` 保存整个组件并核对原生 XML。
- 实例配置先 `fgui_get_component_instance`，再用 `fgui_set_component_instance_controller` 或 `fgui_set_component_instance_property` 设置单个直属实例的控制器、文本/图标覆盖值；不为修改一个实例而打开并改写共享组件定义。控制器须已导出，内部属性须已暴露；字符串含空串，不支持 null 清除。
- 组件定义用 `fgui_get_component_properties` / `fgui_upsert_component_property` / `fgui_remove_component_property` 管理当前根组件的文本(0)/图标(1)映射，内部路径用点号；控制器导出与备注用 `fgui_set_controller_properties(settings={exported,alias})`。实例与定义的五个写操作均可批量，说明见[组件属性](references/component-properties.md)。
- Spine：先 `fgui_get_loader3d` 再 `fgui_set_loader3d`；仅编辑直属 Loader3D 的已有包内资源。导入后的修复用 `fgui_fix_spine_anchor`；绑定/插入时默认修复，包保存边界见下文。
- 状态编辑：先读取 `fgui_get_controllers` / `fgui_get_gears` / `fgui_get_controller_actions`，再编辑页面、Gear 或联动。页面优先用稳定 ID；Gear set 完整替换单个 Gear，Action upsert 省略索引为追加、指定索引为完整替换单条，增删后重读索引。作用于当前根控制器或直属对象；联动可引用直属子组件，不写子组件资源。具体格式见能力参考。
- 属性修改（如 `text`、`icon`、`font` 等白名单属性）进入 Agent 属性事务栈；结构创建、插入和删除没有完整结构快照撤销。
- 文档与持久化验证：使用 `fgui_verify_document` 重新读取活动文档对象树并可传入 `target + expected` 比对组件 XML 磁盘持久化内容；无 `expected` 时仅作为对象树快照；指定 expected 时默认省略整树，需要时传 include_tree=true。
- 保存使用 `fgui_save_document` 或 `fgui_save_all`；放弃全部未保存修改使用 `fgui_discard_document`。
- 视觉检查用 `fgui_capture_document` 获取图像后实际观察资源、布局、遮挡与可见性，大体正确即可，不要求帧或像素一致。`pending_review` 尚未验收；缺图返回 `manual_required`，要求用户自行验证并保留修改，不因缺图 undo/discard。

### 3. 发布

1. 先调用 `fgui_get_publish_settings` 确认输出目录、格式、图集、代码生成和包级覆盖。
2. 明确发布范围：`active`、`packages` 或 `all`。
3. 再调用 `fgui_publish`，按需设置保存、描述文件、分支和超时。
4. 发布前会自动扫描目标包：达到 `1920×1080` 或任一边达到 `2048` 的图片会设置 FairyGUI `alone` 纹理集，确保大图单独打图集、不与小图混排；发布响应会返回实际修正清单。
5. 读取实际输出目录、扩展名、耗时和文件变更清单；文件清单不等于 Git 内容一定变化。
6. 发布期间部分读写 Action 会被阻塞；遇到超时先检查状态和 `.agent/bridge.log`，不要并发重复发布。

## CLI 约定

在独立仓库根目录使用：

```bash
uv sync --frozen
uv run fgui-agent --project /ABSOLUTE/PATH/TO/FAIRYGUI-PROJECT status
uv run fgui-agent --project /ABSOLUTE/PATH/TO/FAIRYGUI-PROJECT ping
uv run fgui-agent --project /ABSOLUTE/PATH/TO/FAIRYGUI-PROJECT packages
uv run fgui-agent --project /ABSOLUTE/PATH/TO/FAIRYGUI-PROJECT tree
uv run fgui-agent --project /ABSOLUTE/PATH/TO/FAIRYGUI-PROJECT replace-object-resource --id n12_ox87 ui://package/resource --expected-type image --save
uv run fgui-agent --project /ABSOLUTE/PATH/TO/FAIRYGUI-PROJECT get-text-style --path root/title
uv run fgui-agent --project /ABSOLUTE/PATH/TO/FAIRYGUI-PROJECT set-text-style --path root/title '{"fontSize":40,"color":"#FFFFFF","align":"center"}' --save
uv run fgui-agent --project /ABSOLUTE/PATH/TO/FAIRYGUI-PROJECT verify-document --max-depth 12 --target root/title --expected '{"fontSize":40}'
```

全局参数 `--project`、`--editor`、`--timeout` 必须位于子命令前。`call` 只用于调试原始 Action，不替代正式 MCP 工具。

## 安装位置与安装方式

面向使用者的 `README.md` 同时提供“AI 快速安装（提示词安装）”和“人类安装”。AI 安装必须实际执行并验证下述同一套安装步骤，不能只返回命令说明。

安装边界必须明确区分：

- FairyGUI Editor 插件安装到每个目标 FairyGUI 工程的 `plugins/agent-bridge/`。
- MCP/CLI 从本机固定目录中的独立 Bridge 仓库或已安装的 Python 工具环境运行，多个工作副本复用，不放入 FairyGUI 工程。
- Skill 可选安装到 Codex 操作的目标代码仓库 `.agents/skills/fgui-agent-bridge/`。
- 团队操作入口由业务根目录 `AGENTS.md` 引用 `FairyGUI-Editor-操作规范.md`，只在 FairyGUI 任务中检查环境；缺少 MCP 时先询问安装或配置，拒绝后不自动调用 MCP/CLI 或直接改 XML。
- `.agent/` 是目标 FairyGUI 工程生成的运行时队列，不是安装文件，也不纳入 Git。

普通使用者优先通过同步脚本选择 FairyGUI 工程并安装插件：

```bash
uv run python scripts/sync_to_project.py --choose-project --apply
```

脚本会先校验所选目录，再写入目标工程的 `plugins/agent-bridge/`；无效目录或取消选择时不得写入。自动化环境可改用 `--project PATH --apply`。

首次安装先读取业务项目的固定版本约定；安装询问必须包含源仓库与发布标签。下面以当前发布 `v0.10.0` 为例；项目明确指定其他标签时替换为该标签。前述同步命令均在 Bridge 仓库目录执行：

```bash
git clone --branch v0.10.0 https://github.com/Henry22Chen/fgui-agent-bridge.git
cd fgui-agent-bridge
uv sync --frozen
```

已有安装先核对 `git status --short` 并保留未提交改动，再执行 `git fetch origin tag v0.10.0`、`git switch --detach v0.10.0` 和 `uv sync --frozen`；固定标签处于 detached HEAD 属于正常状态。同步后必须分别核对 MCP 和插件等于项目指定版本，不能仅以两端 `versionMatch=true` 判断版本正确。保留业务规范中已有的固定版本约定，不能用通用规范覆盖。

Codex 安装采用两层配置，完整示例见源仓库 README 的安装指南：

- 用户级 `~/.codex/config.toml` 的 `mcp_servers.fgui` 指向本机 `.venv/Scripts/fgui-agent-mcp.exe`（Windows）或 `.venv/bin/fgui-agent-mcp`；env 保存本机 Editor 路径与 `PYTHONUTF8=1`。
- 本机启动配置就绪并获准配置后，将共享的 `codex-fgui-project.example.toml` 模板合入本地项目 `.codex/config.toml`，只补相对工程路径，例如：

```toml
[mcp_servers.fgui.env]
FGUI_PROJECT_PATH = 'UIProject/TextDemo.fairy'
```

两层均不固定 `cwd` 或 `fgui-agent-mcp --project`；移除旧固定值，从项目根目录启动 Codex（或用 `codex -C ROOT`），项目需受信任。相对工程路径按 MCP 进程工作目录解析；修改后重启会话并核对目标。其他客户端不假定采用相同继承与工作目录规则。

团队只共享模板；缺少用户级启动命令时，自动加载的项目级 `fgui.env` 会报 `invalid transport` 并阻止会话创建。不要将该片段提交进共享 `.codex/config.toml`；已跟踪该文件时保留其他设置，移出 `fgui` 片段。

Skill 按需复制到目标代码仓库：

```bash
mkdir -p /ABSOLUTE/PATH/TO/TARGET-REPOSITORY/.agents/skills
cp -R .agents/skills/fgui-agent-bridge \
  /ABSOLUTE/PATH/TO/TARGET-REPOSITORY/.agents/skills/
```

将根目录规范和模板复制到业务根目录，并合入已有 `AGENTS.md` 引用，不能只安装 Skill 后期待未加载时自动提示。插件、Skill、规范、引用及模板可提交 Git；同步脚本不自动复制根目录文件、合入引用或配置 MCP。

完成安装后，在 MCP 客户端执行低风险读取：`status → ping → project → packages`，确认目标属于当前副本；仅 CLI ping 成功不算 MCP 已加载。不要以创建、导入、保存或发布作为首次连接测试。

### 同步与更新脚本

`scripts/sync_to_project.py` 支持目录选择和显式路径，两种方式都默认 dry-run，必须传入 `--apply` 才写入。固定版本先检出项目指定标签、执行 `uv sync --frozen`，再同步，省略 `--pull`；下面的 `--pull` 示例只用于未固定版本且明确跟踪开发分支的安装：

```bash
# 打开目录选择器并安装插件
uv run python scripts/sync_to_project.py --choose-project --apply

# 从源仓库拉取更新并同步插件与 Skill
uv run python scripts/sync_to_project.py \
  --pull \
  --project /ABSOLUTE/PATH/TO/FAIRYGUI-PROJECT \
  --skill-root /ABSOLUTE/PATH/TO/TARGET-REPOSITORY \
  --apply

# 或通过 CLI update 命令执行
uv run fgui-agent --project /ABSOLUTE/PATH/TO/FAIRYGUI-PROJECT update --pull --apply
```

`--pull` 使用本地分支的跟踪远端，不会自动切换源仓库或发布标签；detached HEAD 上不使用 `--pull`。从其他仓库迁移时，按上述地址和项目指定标签另行克隆、更新 MCP 的 Bridge 路径，再同步插件与 Skill。

`--project` 与 `--choose-project` 互斥。脚本不创建 Git 元数据、不复制缓存、不删除目标目录中的其他文件。若更新了插件文件，需重新打开 FairyGUI Editor 工程加载。

## 开发与变更同步

任何功能变动都必须在同一变更中完成：

1. 更新实现；修改 `plugin/main.ts` 后重新编译 `plugin/main.js`。
2. 同步 `plugin/package.json`、`pyproject.toml`、`__init__.py` 和 Bridge 常量版本。
3. 更新 README、当前能力参考和本 Skill。
4. 核对插件 capability、Action 分发、Python MCP 装饰器、CLI parser 与文档。
5. 检查同步脚本仍只写入受管理文件，默认保持 dry-run。
6. 确认没有提交 `.agent/`、`.venv/`、`__pycache__/`、`node_modules/`、`main.js.map` 或个人绝对路径。

推荐静态检查：

```bash
uv lock
uv sync --frozen
uv run python -m compileall -q src scripts
uv run fgui-agent --help
uv run fgui-agent-mcp --help
npx -y -p typescript@5.4.5 tsc -p plugin/tsconfig.json --pretty false
git diff --check
```

若 FairyGUI Editor 在线，再使用隔离工程副本验证 `fgui_status → fgui_ping → fgui_get_project`。创建、导入或发布 API 变更应在隔离副本中验证写操作；未做真实 Windows 验证时必须明确标注。

## 安全边界

- `.agent/` 是目标 FairyGUI 工程的运行时队列与日志，不纳入 Git。
- `0.11.0` 使用协议 `2.0` 和按进程隔离的队列；升级后重新加载插件并重启 MCP 会话，旧协议不能继续使用。Windows 只有在没有 FairyGUI 进程时才自动首次启动，已有其他工程或身份无法确认时需手动打开目标工程。
- 同一请求不要重复写入；响应必须按请求 ID 匹配。
- 插件会拒绝执行超过 60 秒未被认领的过期请求，并在 Bridge 初始化时清理残留队列文件；客户端命令超时不代表操作未执行，重试前先检查状态（如 `fgui_status` / `fgui_get_active_document`），避免写操作重复执行。
- 图片、声音、MovieClip 图片序列导入和发布是磁盘写入，执行前确认目标和冲突策略。Transition 声明式/关键帧修改与已有 MovieClip 更新/替换可由 Agent undo/redo 回退；全新资源创建、声音/图片导入和删除不能。
- MovieClip 删除即使传 `force=true` 也会执行引用检查；仍被组件使用时必须先移除引用。
- `replace_object_resource` 本轮仅允许 Image 与 Loader，拒绝 Button `state` 替换，避免误将整个按钮组件替换为单一资源。
- 文本样式修改支持类型与枚举检查，暂不支持自动 external reload。
- 新原生节点、批量属性、按钮绑定、List/ScrollPane、二维 Loader、分组与 Relations 不提供完整 Agent 撤销，实际修改清除旧历史并保持 dirty。无变化且不保存时保留历史；拒绝的输入不会作为成功写入。不要将控件配置验证等同于运行预览点击、滚动或业务逻辑联调。
- `verify_document` 可传入 `target + expected` 执行磁盘 XML 持久化比对，失败响应保留结构化 `error.details`（包含 `stage`、expected、actual、differences）。
- Loader3D、Controller、Gear 和联动默认不保存，实际修改清空旧 Agent 历史，无完整撤销；`save=true` 保存整个组件并回读 XML，写入失败按实际响应报告，不假装已回滚。Controller 页面/控制器删除仍未开放。
- 组件实例属性、组件定义映射和控制器导出设置也没有完整 Agent 撤销。定义仅编辑当前根组件；实例仅改父文档覆盖，保存时比对完整原生 XML。移除定义不扫描或清理其他文档已有覆盖；同一实例设置可能受内部 Gear/联动影响，失败保留实际修改。
- SpineFixer 仅支持已验证的 Spine 4.2 二进制；绑定资源或插入 Spine 默认修复尺寸、锚点和 PMA 并保存所属包，独立于组件 `save=false`，不能由文档 undo/discard 回退。可显式 `fix_spine=false`；查询、截图和仅调整播放属性不修复。
- 不允许删除根组件；不要把 `discard`、`undo` 和 `save` 混为同一语义。
- 根组件点击穿透使用可序列化的 `opaque=false`；不要把无法持久化的根 `touchable` 宣称成功。
- 不提交个人绝对路径、密钥、用户级 MCP 配置或本地项目配置中的 `fgui` 片段；相对工程路径以不自动加载的模板随 Git 分发。

## 输出要求

完成操作或维护任务时报告：

- 涉及的包、文档、对象或文件；
- 是否保存、发布、放弃或同步，以及作用范围；
- 执行了哪些静态检查、MCP 握手和编辑器验证；结构、持久化和视觉结论分开报告；
- 哪些真实平台或环境仍未验证。
