# Agent Bridge 当前能力参考

> 这是独立 `fgui-agent-bridge` 仓库在 2026-09-29 的能力快照。功能变动时必须同步本文件，并以源码实际签名为最终依据。

## 版本与通道

- Bridge 版本：`0.8.8`
- FairyGUI 插件 ID：`com.fgui.agent-bridge`
- 代码真源：独立公开仓库；业务工程只安装插件与 Skill 快照
- 队列协议：`1.0`
- FairyGUI Editor 基线：`6.1.4`
- MCP 工具数：56；`fgui_status` 和 `fgui_use_project` 为 Python 本地能力
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
| `fgui_replace_object_resource` | target、resource_url、expected_type、state?、save? | 通过 Editor API 替换 Image/Loader 资源引用，不支持 Button state |
| `fgui_get_text_style` / `fgui_set_text_style` | target、style、save? | 读取或设置文本对象样式并回读 |
| `fgui_verify_document` | `max_depth`, target?, `expected?`, `read_xml=true` | 无 expected 为快照；有 expected 时比对 Editor/磁盘 XML |
| `fgui_insert_object` / `fgui_remove_object` | 资源 URL、坐标 / 目标 | 插入已有资源或删除非根对象 |
| `fgui_get_loader3d` / `fgui_set_loader3d` | 对象定位；读取 `include_asset_info=true`；修改 `resource_url?`, `animation_name?`, `skin_name?`, `playing?`, `loop?`, `frame?`, `save=false`, `verify=true`, `skip_name_validation=false`, `fix_spine=true` | 读取/修改直属 Loader3D 的包内 Spine；省略保持，空字符串清除 |
| `fgui_fix_spine_anchor` | `url?` 或 `package_name` + `item_name/item_path` | 修复 Spine 包围盒、锚点及 PMA，保存包元数据 |
| `fgui_capture_document` | `scale=1`, `expected_document_url?` | 当前组件 PNG；MCP 返回图像块，CLI 返回文件元数据 |
| `fgui_get_controllers` / `fgui_create_controller` | 无 / `name`, `page_names?`, `save=false` | 读取根控制器/页面/当前页；创建空或有初始页面的控制器 |
| `fgui_add_controller_page` / `fgui_rename_controller_page` | `controller_name`, `name`, `save=false`；重命名另需页面定位 | 末尾追加或保留 ID 改名 |
| `fgui_set_controller_page` | `controller_name`, `page_id/page_name/page_index` 三选一, `save=false` | 原生切页，应用 Gear/联动，不修改 homePage |
| `fgui_get_gears` / `fgui_set_gear` | 对象定位；修改 `gear_type`, `controller_name`, `default_value?`, `page_values?`, `visible_page_ids?`, `save=false` | 读取/完整替换一个 Gear；其余 Gear 及缓动等附加配置保留 |
| `fgui_get_controller_actions` / `fgui_upsert_controller_action` / `fgui_remove_controller_action` | `controller_name`；upsert 另传 `action`, `action_index?`, `save=false`；remove 必传索引 | 读取联动及可用目标页面；省略索引追加，指定索引替换或删除单条 |
| `fgui_list_transitions` / `fgui_get_transition` | 无 / `name` | 读取当前组件的 Transition |
| `fgui_upsert_transition` / `fgui_remove_transition` | 类型化 `transition` / `name` | 声明式创建、完整替换或删除 Transition |
| `fgui_add_transition_item` / `fgui_update_transition_item` / `fgui_remove_transition_item` | `name`、类型化 `item`、`item_index` | 原子增删改 Transition 关键帧 |
| `fgui_preview_animation` | `kind`, `operation`, Transition 名称或 MovieClip 目标 | 播放、暂停、停止、跳帧或查询状态，不保存 |
| `fgui_undo` / `fgui_redo` / `fgui_get_history` | 无 | Agent 事务优先的回退和历史读取 |
| `fgui_save_document` / `fgui_save_all` / `fgui_discard_document` | 无 | 保存、全部保存或放弃当前文档修改 |
| `fgui_get_publish_settings` / `fgui_publish` | 包名? / 范围、包、分支、保存策略 | 读取或执行现有发布配置；发布前自动将 1920×1080/2K 级大图设置为 FairyGUI `alone` 纹理集，避免与小图混排 |

## 组件与动画语义

- **页面与作用域**：Controller/Action 属于当前文档根组件，Gear 属于直属子对象；联动可引用当前/直属子组件控制器，不改子组件资源。页面定位三选一，优先稳定 ID；名称不允许空白、逗号或控制字符，同一控制器中新页面名称不能重复。创建有页面的控制器或向空控制器追加首页时自动选中第一页。切页不修改 homePage，重开可能按首页规则重选。
- **Gear 配置**：display 用 `visible_page_ids`，空数组是全页可见；其余类型必须传 `default_value` 和 `page_values=[{"pageId":"0","value":...}]`，未列页使用默认值。text 为不含竖线的字符串；icon 为图片 ui:// 或空串；xy 为整数 `{x,y}`；size 为非负整数 `{width,height,scaleX?,scaleY?}`（缩放默认 1）；color 为 `{color:"#RRGGBB",strokeColor?:"#RRGGBB"}`（描边默认黑）。数值绝对值不超过 1000000。set 是完整替换而非单页补丁；读取中的未序列化默认值为 null，其它 Gear 返回 XML。
- **Action 配置**：`type` 为 change_page/play_transition；公共 `fromPageIds`、`toPageIds` 都使用源控制器页面 ID，省略/空数组匹配任意页，两组条件同时满足才执行。change_page 使用 `objectId`（空串/省略为当前组件）、`controllerName`、`targetPageId`；play_transition 使用 `transitionName`、`repeat`（默认 1，正整数或 -1 循环）、`delay`（默认 0，0..86400 秒）、`stopOnExit`（默认 false）。引用必须存在，按引用图拒绝自引用/循环。索引从 0 开始，增删后重读；更新完整替换单条，不传读取元数据 index/xml。未知类型可读取、保留、删除，不能 upsert。
- **预览与外观**：编辑 Action 不触发执行；普通编辑模式切页可应用控制器/Gear，但 Editor 6.1.4 只在原生运行预览中播放联动 Transition。单独 `fgui_preview_animation` 不等于验证联动触发。Gear 最终外观还受布局、autoSize、基础 visible、显示锁等影响，不能只看对象树 visible 判断显隐。
- **Loader3D**：仅已有包内 Spine，加载和名称校验最长等待 8 秒；busy 时等待，不重复写入。跳过名称校验不能绕过加载失败或资源类型校验。修改失败按响应区分实际状态与回退结果；`verify_document` 可校验资源 URL、动画、皮肤、播放及帧字段。

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
- Loader3D、Controller、Gear、Action 默认不保存，实际编辑清空旧 Agent 历史，无完整撤销；无变化且不保存时保留历史。`save=true` 保存整个组件并回读 XML；Gear 校验目标全部 Gear，Action 校验内容和顺序。保存失败报告磁盘状态，不声称成功或完整回滚；保留 `error.details`。
- SpineFixer 只接受已验证的 Spine 4.2 二进制 .skel 有效导出包围盒，修复尺寸/锚点并设置 pma=false，回读 package.xml。绑定 resource_url 或插入 Spine 默认修复并保存所属包，独立于组件 save=false，不能用文档 undo/discard 回退；`resourceFix` 单独报告。`fix_spine=false` / `--no-fix-spine` 可跳过，只读及仅播放属性调整不修复，不提供 Spine 导入。
- 截图需实际观察，资源、布局、遮挡与可见性大体正确即可。成功为 pending_review；缺图/坏图返回 manual_required，要求用户自行验证，保留修改，不自动回滚。结构、持久化和视觉结论分别报告；对象树存在 Spine 不等于已捕获其图像。
- 截图范围：scale<=4、单边<=4096、总像素<=8388608、PNG<=16 MiB；仅写 `.agent/captures/`，一天前的本工具截图会清理。
- 发布前先用 `fgui_get_publish_settings`。发布期间桥接会阻止资源、动画及文档写操作。

## CLI 映射

正式子命令包括：

- 基础：`status`、`ping`、`project`、`packages`、`items`、`open`、`active`、`tree`、`select`、`set`、`insert`、`remove`
- 资源：`create-component`、`create-button`、`import-image`、`import-font`、`import-sound`、`create-movieclip`、`get-movieclip`、`update-movieclip`、`remove-movieclip`、`get-loader3d`、`set-loader3d`、`fix-spine-anchor`
- Transition：`transitions`、`get-transition`、`upsert-transition`、`remove-transition`、`add-transition-item`、`update-transition-item`、`remove-transition-item`
- 属性与验证：`replace-object-resource`、`get-text-style`、`set-text-style`、`verify-document`、`capture-document`
- 状态编辑：`controllers`、`create-controller`、`add-controller-page`、`rename-controller-page`、`set-controller-page`、`get-gears`、`set-gear`、`get-controller-actions`、`upsert-controller-action`、`remove-controller-action`
- 预览：`preview-transition`、`preview-movieclip`
- 保存发布：`save`、`discard`、`save-all`、`history`、`undo`、`redo`、`publish-settings`、`publish`
- `call` 仅调试原始 Action，不替代正式命令。

全局参数 `--project`、`--editor`、`--timeout` 必须置于子命令前。Gear CLI 配置 JSON 使用 defaultValue/pageValues/visiblePageIds；Action JSON 与上述配置相同，使用 camelCase。

## 关键限制

- 兼容基线是 FairyGUI Editor `6.1.4`；其他 6.x 尚未完成真实环境矩阵验证。
- Loader3D 专用接口支持已有包内 Spine；不包含 DragonBones、SWF、外部 Spine 导入或运行时游戏代码层动画控制。
- 通用包资源的删除、移动、重命名仍未开放；只提供带 `force` 和引用检查的 MovieClip 删除。
- 不开放 Controller/页面删除与页面重排、Gear 解绑/删除或百分比 XY/Alpha 等高级编辑、跨多层子组件联动及特殊跟随页面值；文本样式不支持自动 external reload。
- Windows Editor 6.1.4 已有隔离实测，未覆盖所有对象/业务组合；不等于业务工程发布和 Unity/设备验收。实现细节及历史验证记录见仓库 `tests/reports/`，不作为技能操作步骤。

## 文件变动同步矩阵与对照检查

| 变动文件/区域 | 需要同步 |
| --- | --- |
| `plugin/main.ts` Action、参数、返回值、动画序列化、阻塞策略、协议或版本 | `plugin/main.js`、三处版本、README、本 Skill 与本文件 |
| `src/fairygui_agent/mcp_server.py` MCP 工具或参数 | `src/fairygui_agent/bridge_client.py` capability、README、CLI/Skill 映射、本文件 |
| `src/fairygui_agent/cli.py` 子命令、参数或退出码 | README CLI、本 Skill、本文件 |
| `src/fairygui_agent/bridge_client.py` 队列、能力校验、超时或响应语义 | README 安装/协议、本 Skill、本文件 |

1. `plugin/package.json`、`pyproject.toml`、`src/fairygui_agent/__init__.py`、`plugin/main.ts` 和 `plugin/main.js` 版本一致。
2. 插件 capability、Action 分发、Python capability 检查、MCP 工具、CLI parser 和文档清单一致。
3. `plugin/main.ts` 与重新编译的 `plugin/main.js` 一致。
4. 创建/导入/预览变更应在 FairyGUI Editor `6.1.4` 隔离工程副本中验证，避免污染正式工程。
