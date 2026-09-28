# Agent Bridge 当前能力参考

> 这是独立 `fgui-agent-bridge` 仓库在 2026-09-28 的能力快照。功能变动时必须同步本文件，并以源码实际签名为最终依据。

## 版本与通道

- Bridge 版本：`0.8.6`
- FairyGUI 插件 ID：`com.fgui.agent-bridge`
- 代码真源：独立公开仓库；业务工程只安装插件与 Skill 快照
- 队列协议：`1.0`
- FairyGUI Editor 基线：`6.1.4`
- MCP 工具数：51，其中新增资源引用、文本样式和文档验证工具；`fgui_status` 和 `fgui_use_project` 为 Python 本地能力
- 传输：MCP stdio；底层为目标工程 `.agent/` 下的本地 JSON 文件队列
- 运行时目录：`.agent/requests`、`.agent/processing`、`.agent/responses`、`.agent/status.json`、`.agent/bridge.log`
- `.agent/` 是运行时数据，不纳入 Git

## MCP 工具签名

以下签名以 `src/fairygui_agent/mcp_server.py` 为准；工具参数使用 Python snake_case，桥接请求内部映射为 camelCase。

| 工具 | 主要参数 | 用途 |
| --- | --- | --- |
| `fgui_status` / `fgui_ping` / `fgui_use_project` | — / — / `project_path` | 读取状态、握手或选择工程 |
| `fgui_get_project` / `fgui_list_packages` | 无 | 读取工程或包 |
| `fgui_list_items` | `package_name`, `item_type?` | 列出包内资源 |
| `fgui_open_document` | `package_name`, `item_name` | 打开已有组件文档 |
| `fgui_create_component` | 包、名称、尺寸、目录、扩展、导出、重名策略 | 新建组件资源 |
| `fgui_import_image` / `fgui_import_font` / `fgui_import_sound` | 包、绝对路径、目录、名称、冲突策略、导出 | 导入或替换本地资源 |
| `fgui_create_button` | 包、名称、尺寸、模式、状态图片、目录 | 创建 Common/Check/Radio 标准 Button |
| `fgui_create_movieclip` | 包、名称、有序 `frame_paths`、FPS、延迟、Swing、目录 | 从本地图片序列创建/替换 MovieClip |
| `fgui_get_movieclip` / `fgui_update_movieclip` / `fgui_remove_movieclip` | MovieClip 资源定位；更新可传帧、FPS、Speed、延迟、Swing | 读取、更新或显式强制删除 MovieClip |
| `fgui_get_active_document` / `fgui_get_tree` | 无 / `max_depth` | 读取活动文档或对象树 |
| `fgui_select_object` / `fgui_set_property` | ID、路径或唯一名称 | 选择对象或修改白名单属性 |
| `fgui_replace_object_resource` | target、resource_url、expected_type、state?、save? | 通过 Editor API 替换 Image、Loader 或 Button 资源引用 |
| `fgui_get_text_style` / `fgui_set_text_style` | target、style、save? | 读取或设置文本对象样式并回读 |
| `fgui_verify_document` | max_depth、target? | 重新读取活动文档对象树和 Editor 状态 |
| `fgui_insert_object` / `fgui_remove_object` | 资源 URL、坐标 / 目标 | 插入已有资源或删除非根对象 |
| `fgui_list_transitions` / `fgui_get_transition` | 无 / `name` | 读取当前组件的 Transition |
| `fgui_upsert_transition` / `fgui_remove_transition` | 类型化 `transition` / `name` | 声明式创建、完整替换或删除 Transition |
| `fgui_add_transition_item` / `fgui_update_transition_item` / `fgui_remove_transition_item` | `name`、类型化 `item`、`item_index` | 原子增删改 Transition 关键帧 |
| `fgui_preview_animation` | `kind`, `operation`, Transition 名称或 MovieClip 目标 | 播放、暂停、停止、跳帧或查询状态，不保存 |
| `fgui_undo` / `fgui_redo` / `fgui_get_history` | 无 | Agent 事务优先的回退和历史读取 |
| `fgui_save_document` / `fgui_save_all` / `fgui_discard_document` | 无 | 保存、全部保存或放弃当前文档修改 |
| `fgui_get_publish_settings` / `fgui_publish` | 包名? / 范围、包、分支、保存策略 | 读取或执行现有发布配置；发布前自动将 1920×1080/2K 级大图设置为 FairyGUI `alone` 纹理集，避免与小图混排 |

## 动画语义

### Transition

- 使用类型化 JSON；时间单位为 FairyGUI frame，`frameRate` 决定实际播放速度。
- 支持全部 FairyGUI 原生轨道：`XY`、`Size`、`Pivot`、`Scale`、`Skew`、`Alpha`、`Rotation`、`Color`、`Animation`、`Visible`、`Sound`、`Transition`、`Shake`、`ColorFilter`、`Text`、`Icon`。
- Tween 支持持续帧数、缓动、重复、Yoyo、路径和自定义缓动数据；路径读取为 `{encoded, points}`，再次写入应优先复用 `encoded`，避免丢失 Editor 自动生成的端点或控制点。
- `fgui_upsert_transition`、关键帧原子编辑和删除均为一次 Agent 动画事务，可用 `fgui_undo` / `fgui_redo` 整步回退；若文档动画已被外部操作改写，回退会拒绝覆盖。
- `Sound` 轨道只接受工程内声音类型的 `ui://` URL；可先使用 `fgui_import_sound` 导入。嵌套 `Transition` 必须已存在于同一组件。
- `playTimes` 是 Editor 运行态信息，不序列化到组件 XML；持久播放次数应使用 `autoPlayRepeat` 或轨道自身的播放次数字段。
- `fgui_preview_animation(kind="transition")` 只操作 Editor 预览。播放状态、暂停和 Timeline 跳帧不写入资源文件。

### MovieClip

- `fgui_create_movieclip` 接收有序绝对图片路径；FairyGUI 原生 `AniData.ImportImages` 将帧嵌入 `.jta`。不会为各帧额外创建包内图片 `ui://` 资源。
- 可设置 `fps` (`1..255`)、`speed`、`repeat_delay` (`0..255` 额外延迟帧)、`swing` 和每帧 `frame_delays` (`0..255`)。
- 创建/更新响应包含本次 `frameSources` 与 `resourceChanges`；重新读取 `.jta` 时只返回可持久读取的帧索引、矩形和延迟，不返回原始本地路径。
- `fgui_update_movieclip` 传入 `frame_paths` 时替换完整帧序列；所有图片必须存在且为 FairyGUI 支持的图片格式。失败时恢复原 `.jta`、尺寸和导出设置；全新创建失败会清理本次新建资源。
- 已有 MovieClip 的 `update` 与冲突策略 `replace` 记录文件快照，可用 Agent undo/redo 回退；全新创建和删除不进入可逆资源生命周期历史。
- `fgui_preview_animation(kind="movieclip")` 支持 `play`、`pause`、`stop`、`seek`、`next`、`previous`、`status`；仅改变编辑器内对象预览状态，不保存。
- MovieClip 创建/更新、图片序列处理和声音导入均可能写磁盘；它们不由 `fgui_discard_document` 自动回滚。删除 MovieClip 必须显式 `force=True`，且存在组件引用时拒绝删除。

## 创建、导入、保存与发布

- 包内目录输入可写 `Folder/SubFolder`，桥接统一为 `/Folder/SubFolder/`；缺失目录可按参数创建。
- 图片、字体和声音导入支持 `error`、`auto_rename`、`replace`。`replace` 只允许相同资源类型。
- 所有本地导入路径均必须是绝对路径；导入和替换是磁盘写入。
- `fgui_save_document` / `fgui_save_all` 保存文档和包改动；`fgui_discard_document` 只放弃当前文档未保存改动。
- 发布前先用 `fgui_get_publish_settings`。发布期间桥接会阻止资源、动画及文档写操作。

## CLI 映射

正式子命令包括：

- 基础：`status`、`ping`、`project`、`packages`、`items`、`open`、`active`、`tree`、`select`、`set`、`insert`、`remove`
- 资源：`create-component`、`create-button`、`import-image`、`import-font`、`import-sound`、`create-movieclip`、`get-movieclip`、`update-movieclip`、`remove-movieclip`
- Transition：`transitions`、`get-transition`、`upsert-transition`、`remove-transition`、`add-transition-item`、`update-transition-item`、`remove-transition-item`
- P0 验证：`replace-object-resource`、`get-text-style`、`set-text-style`、`verify-document`
- 预览：`preview-transition`、`preview-movieclip`
- 保存发布：`save`、`discard`、`save-all`、`history`、`undo`、`redo`、`publish-settings`、`publish`
- `call` 仅调试原始 Action，不替代正式命令。

全局参数 `--project`、`--editor`、`--timeout` 必须置于子命令前。

## 关键限制

- 兼容基线是 FairyGUI Editor `6.1.4`；其他 6.x 尚未完成真实环境矩阵验证。
- Loader3D 专用接口支持已有包内 Spine；不包含 DragonBones、SWF、外部 Spine 导入或运行时游戏代码层动画控制。
- 通用包资源的删除、移动、重命名仍未开放；只提供带 `force` 和引用检查的 MovieClip 删除。
- Windows 尚未完成真实环境端到端验证。

## 文件变动同步矩阵与对照检查

| 变动文件/区域 | 需要同步 |
| --- | --- |
| `plugin/main.ts` Action、参数、返回值、动画序列化、阻塞策略、协议或版本 | `plugin/main.js`、三处版本、README、本 Skill 与本文件 |
| `src/fairygui_agent/mcp_server.py` MCP 工具或参数 | `src/fairygui_agent/bridge_client.py` capability、README、CLI/Skill 映射、本文件 |
| `src/fairygui_agent/cli.py` 子命令、参数或退出码 | README CLI、本 Skill、本文件 |
| `src/fairygui_agent/bridge_client.py` 队列、能力校验、超时或响应语义 | README 安装/协议、本 Skill、本文件 |

1. `plugin/package.json`、`pyproject.toml`、`src/fairygui_agent/__init__.py`、`plugin/main.ts` 和 `plugin/main.js` 版本一致。
2. 插件 capability、Action 分发、Python 动画 capability 检查、MCP 工具、CLI parser 和文档清单一致。
3. `plugin/main.ts` 与重新编译的 `plugin/main.js` 一致。
4. 创建/导入/预览变更应在 FairyGUI Editor `6.1.4` 隔离工程副本中验证，避免污染正式工程。

### P0 可信持久化验证（0.8.5）

- `replace_object_resource` 本轮仅允许 Image/Loader，拒绝 Button `state`，避免把整个 Button 替换误报为状态资源替换。
- 保存时检查 Editor 文档变为未修改；`save=false` 或 `verify=false` 不会声称磁盘已持久化。
- `verify_document` 可传 `target + expected`，默认读取组件 XML 比对目标字段；无 `expected` 时只是快照。
- 失败响应保留 `error.details`，包含 `stage`、expected、actual 和 differences（如有）。
- 自动 external reload、真实 FairyGUI Editor 端到端和 Unity/真机验收仍未完成。

## Loader3D / Spine 与组件视觉验证（0.8.5）

- `fgui_get_loader3d(object_id|object_path|object_name, include_asset_info=true)`：读取资源、动画、皮肤、播放和布局信息；列表不可用时返回原因。
- `fgui_set_loader3d(..., resource_url?, animation_name?, skin_name?, playing?, loop?, frame?, save=false, verify=true, skip_name_validation=false)`：仅修改当前文档直属 Loader3D；嵌套对象请先打开所属组件。仅支持已导入包内 Spine，DragonBones 不在首版范围。缺省保持原值，空字符串清除，不支持 Agent undo/redo。
- 修改前加载资源与校验名称，等待最长 8 秒；跨帧期间拒绝冲突命令，文档/对象/属性变化或工程关闭使请求失效。跳过名称校验不能绕过加载失败、超时或资源类型校验。
- 修改后 Editor 拒绝时尽力恢复原属性并返回回退结果；保存失败报告磁盘状态不确定，不宣称回滚或持久化成功。`verify_document` 支持 `resourceURL`、`animationName`、`skinName`、`playing`、`loop`、`frame`；类型为 `loader3d`。
- `fgui_capture_document(scale=1, expected_document_url?)`：仅截当前组件，以 MCP 图像块返回。scale 最大 4，单边最大 4096，总像素最大 8388608，PNG 最大 16 MiB。仅写工程 `.agent/captures/`，超过一天的本工具截图会清理。
- 成功获取图片为 `pending_review`，仍需 Agent 观察。视觉上大体正确即可，检查资源、位置、大小、皮肤、遮挡与可见性，不要求动画帧或像素与效果图完全一致。
- 获取图片失败返回 `manual_required`、原因和人工检查指引，**必须要求用户自行验证，保留已完成修改，不自动 undo/discard**。结构、持久化与视觉结论分别报告。
- `spineCaptureSupported` 是已测捕获路径的能力信息（6.1.4 实测），`spinePresentInTree` 仅表示存在资源；`spineCaptured=null` 表示本次图像尚需观察，不能由对象树自动判定成功。
- CLI 对应 `get-loader3d --id ID`、`set-loader3d --id ID '{"skinName":"default"}' --save`、`capture-document --scale 1`。CLI 返回截图文件元数据，MCP 才返回图像块。
- 不自动发布 UI 包，不验证 Unity 运行时换装。实机结果和限制见 `tests/reports/spine-visual-validation.md`。

截图实现先以独立 UpdateContext 更新组件，消除 Editor 外层视口裁剪，再 GetScreenShot；finally 恢复 Stage 渲染并释放返回纹理。该处理已用高于视口的混合组件验证。

## 0.8.5 审查修复与 SpineFixer

- 新增 `fgui_fix_spine_anchor(url? | package_name + item_name/item_path)`，对应 CLI `fix-spine-anchor URL`。可在现有导入流程结束后独立调用；本轮没有增加 Spine 文件导入接口。
- 算法来自工程 `SpineFixer`：读取 Spine **4.2 二进制 .skel** 的导出包围盒，宽高四舍五入，按原点比例和 Y 轴翻转换算 anchor，设置 `pma=false`。Editor 6.1.4 对小数锚点向零截断，MCP 显式使用相同宿主语义并回读校验。
- 版本未知、头部截断、非有限值、零/负包围盒或整数越界明确失败，不猜测尺寸，不回退到默认 100×100。其它 Spine 版本或 JSON 格式暂不自动修复。
- `fgui_set_loader3d(resource_url=..., fix_spine=true)` 与 `fgui_insert_object(..., fix_spine=true)` 默认先修复 Spine；仅调整播放/皮肤而未传 resource_url 时不隐式修复。只读 get/capture 不写资源。
- 修复会保存**所属包的元数据**（与原 SpineFixer 一致），并回读 package.xml。该资源写入独立于组件 `save=false`，不能由文档 undo/discard 回滚。结果用 `resourceFix` 分开报告；组件后续失败也保留已完成资源修复的信息。
- 可显式传 `fix_spine=false`，CLI 为 `--no-fix-spine`，沿用已修复资源或自行处理不支持版本。旧插件缺少修复能力时拒绝默认自动修复请求，不会静默忽略参数。
- Loader3D 实际修改后清空旧 Agent undo/redo；校验失败、无变化操作保留原历史。保存失败仍清空旧历史；完整回退恢复写入前的 dirty 状态。MCP 原生 undo/redo 回退保持未保存 Loader3D 修改标记，保存或放弃后结束该保护。
- 异步响应在认领请求时固定目标工程目录，成功/失败回调不使用可能已切换的全局目录。
- PNG 除块 CRC 外，还验证有界 zlib 解压、完整流、精确扫描行长度与滤波器值。支持 Unity 非交错 8-bit 灰度/RGB/灰度 Alpha/RGBA 截图；坏图或其它编码转 `manual_required`，要求用户自行验证，不回滚修改。
- 验证与文件索引见 `tests/reports/spine-fixer-review-fixes.md`。

## Controller 基础编辑（0.8.6）

| MCP 工具 | 参数与作用 |
| --- | --- |
| `fgui_get_controllers` | 读取当前文档根组件所有控制器，包含页面 ID/名称/索引、当前页及只读 homePage 信息 |
| `fgui_create_controller` | `name, page_names?, save=false`；缺省创建空控制器，指定页面时自动选中第一页 |
| `fgui_add_controller_page` | `controller_name, name, save=false`；末尾追加，已有 ID 与顺序保留，空控制器的首个页面自动选中 |
| `fgui_rename_controller_page` | `controller_name, name, page_id?/page_name?/page_index?, save=false`；只改名称，保留页面 ID |
| `fgui_set_controller_page` | `controller_name, page_id?/page_name?/page_index?, save=false`；通过原生 setter 应用 Gear/联动 |

页面定位三选一，优先使用稳定的 `page_id`；索引从 0 开始，重复名称拒绝按名称定位。新名称不允许空白、逗号或控制字符，同一控制器中新建页面名称不能重复。控制器名称必须唯一。嵌套组件需先打开所属文档，本批不开放删除控制器/页面、重排、Gear 编辑或联动配置编辑。

默认只修改 Editor 内存；`save=true` 保存整个组件并回读实际 XML 中的控制器页面及 selected 字段。切换当前页不会修改运行时 `homePage`；Editor 重开文档可能按首页规则重选页面，不能将当前页保存当作运行时首页设置。实际改动清空旧 Agent undo/redo，不支持完整 Controller/Gear 联动撤销；未保存内容可通过 discard 放弃整个文档。无变化操作不清历史，但显式保存后清历史。写入或保存失败报告实际状态，不假装联动已回滚。

CLI：`controllers`、`create-controller State --pages Idle Active --save`、`add-controller-page State Disabled`、`rename-controller-page State Enabled --page-id 1`、`set-controller-page State --page-index 1 --save`。全局 `--project` 放在子命令前。没有新增删除命令。

验证结果及文件索引：`tests/reports/controller-basic-editing.md`。
