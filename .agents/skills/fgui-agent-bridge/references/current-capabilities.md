# Agent Bridge 当前能力参考

> 这是独立 `fgui-agent-bridge` 仓库在 2026-10-20 的能力快照。功能变动时必须同步本文件，并以源码实际签名为最终依据。

## 版本与通道

- Bridge 版本：`0.13.0`（Git 标签 `v0.13.0`）
- FairyGUI 插件 ID：`com.fgui.agent-bridge`
- 代码与安装源：[Henry22Chen/fgui-agent-bridge](https://github.com/Henry22Chen/fgui-agent-bridge)；业务工程只安装插件与 Skill 快照
- 队列协议：`2.0`
- FairyGUI Editor 基线：`6.1.4`
- MCP 工具数：95；`fgui_status`、`fgui_use_project` 和 `fgui_diagnostics` 为 Python 本地能力
- 传输：MCP stdio；底层为目标工程 `.agent/` 下的本地 JSON 文件队列
- 实例目录：`.agent/instances/<PID>-<启动时间>/` 内的 `requests`、`processing`、`responses` 和 `status.json`；根目录 `.agent/status.json` 只作诊断快照，`.agent/bridge.log` 为日志
- Windows 校验插件当前工程路径、`editorProcessId`、`editorProcessStartedAt` 和真实进程 exe；启动时间是 UTC `yyyyMMddHHmmssfffffff` 文本，避免 PID 复用与浮点精度损失
- IL2CPP 宿主不支持 `.NET Process.StartTime` 时，初始化运行一次隐藏 PowerShell 只读探针，仅查询宿主提供的 PID；失败记录 `editorIdentityError`，客户端拒绝复用
- 慢响应不会启动进程；首次启动使用跨 MCP 锁和 30 秒冷却。有身份不明的现存 Editor 或多个目标实例时明确报错，不启动、不按标题猜测或自动切换工程
- `.agent/` 是运行时数据，不纳入 Git

## MCP 工具签名

以下签名以 `src/fairygui_agent/mcp_server.py` 为准；工具参数使用 Python snake_case，桥接请求内部映射为 camelCase。

| 工具 | 主要参数 | 用途 |
| --- | --- | --- |
| `fgui_status` / `fgui_ping` / `fgui_use_project` | — / — / `project_path` | 读取状态、握手或选择工程 |
| `fgui_get_project` / `fgui_list_packages` | 无 | 读取工程或包 |
| `fgui_list_items` | `package_name`, `item_type?` | 返回 `{package, items}` 对象，与插件响应一致 |
| `fgui_open_document` | `package_name`, `item_name` | 打开已有组件文档 |
| `fgui_create_component` | 包、名称、尺寸、目录、扩展、导出、重名策略 | 新建组件资源 |
| `fgui_import_image` / `fgui_import_font` / `fgui_import_sound` | 包、绝对路径、目录、名称、冲突策略、导出 | 导入或替换本地资源 |
| `fgui_create_button` | 包、名称、尺寸、模式、状态图片、目录 | 创建 Common/Check/Radio 标准 Button |
| `fgui_create_movieclip` | 包、名称、有序 `frame_paths`、FPS、延迟、Swing、目录 | 从本地图片序列创建/替换 MovieClip |
| `fgui_get_movieclip` / `fgui_update_movieclip` / `fgui_remove_movieclip` | MovieClip 资源定位；更新可传帧、FPS、Speed、延迟、Swing | 读取、更新或显式强制删除 MovieClip |
| `fgui_get_objects` | document_url, targets, fields? | 指定字段批量读取根/直属对象并取 revision，空 targets 仅取 revision |
| `fgui_apply_batch` / `fgui_get_batch_result` | document_url, expected_revision, operation_key, operations, dry_run=false, save=false, verbose=false / document_url, operation_key, verbose=false | 一条请求 1..200 项；默认摘要；失败/超时查回执，非原子事务 |
| `fgui_capture_states` | document_url, states, scale=0.5, columns=3, max_cell=640 | 一次 1..12 个设计态截图及恢复，返回编号联系图与标签映射 |
| `fgui_begin_external_edit` / `fgui_finish_external_edit` | document_url / document_url, token, allow_unchanged_dirty=false | 干净文档交接与完整快照未变时重载；不自动写 XML/保存 |
| `fgui_diagnostics` | limit=20（1..100） | 当前 MCP 进程内部计时/字节，既不唤醒也不包含调用端耗时 |
| `fgui_get_active_document` / `fgui_get_tree` | 无 / `max_depth` | 读取活动文档或对象树 |
| `fgui_select_object` / `fgui_set_property` | ID、路径或唯一名称 | 选择对象或修改白名单属性 |
| `fgui_replace_object_resource` | target、resource_url、expected_type、state?、save? | 原生替换 Image/Loader 或直属组件实例，expected_type 可为 image/component；默认保留尺寸，实例返回前后覆盖清单；不支持 Button state |
| `fgui_get_text_style` / `fgui_set_text_style` | target、style、save? | 读取或设置文本对象样式并回读 |
| `fgui_create_object` | `object_type`, name?, x/y/width/height?, insert_index?, group_member_ids?, save=false | 创建 text/richtext/inputtext/loader/list/group/graph；保存 group 必须指定成员 |
| `fgui_set_properties` | target、`properties`、save=false | 一次预检和批量写入白名单属性；尺寸忽略 Pivot 位移，坐标最后应用 |
| `fgui_get_image_settings` / `fgui_set_image_settings` | 图片 url 或包/资源定位；修改 `settings`, save=false | 包级缩放/九宫格：`scaleMode=none/9grid/tile`、`scale9Grid={x,y,width,height}`、`gridTile=0..31` |
| `fgui_get_button_binding` / `fgui_set_button_binding` | target；修改 `settings`, save=false | `controllerName`、`pageId`、`selected`；空控制器名清除绑定 |
| `fgui_get_list_settings` / `fgui_set_list_settings` | target；修改 `settings`, save=false | `layout`、`repeatX/repeatY`、`lineGap/columnGap`、`align/vAlign`、`autoResizeItem`、`selectionMode`、`clearOnPublish`（发布清空，不删除编辑器预置项） |
| `fgui_get_list_item_resources` / `fgui_set_list_item_resources` | target；修改 `settings={defaultItem?,items?}`, save=false | 默认项资源与预置项增删重排、资源/名称/标题/图标/属性覆盖；`sourceIndex` 保留原项，items 完整替换，详见[列表项编辑](list-items.md) |
| `fgui_get_scroll_settings` / `fgui_set_scroll_settings` | target；修改 `settings`, save=false | 根组件或原生 List：`overflow`、`scroll`、`scrollBarDisplay`、`scrollBarFlags`、`pageMode`、`pageControllerName` |
| `fgui_get_group_settings` / `fgui_set_group_settings` | target；修改 settings, save=false | 分组 advanced、布局和主格设置，详见[Editor 设置](editor-settings.md) |
| `fgui_get_input_settings` / `fgui_set_input_settings` | target；修改 settings, save=false | InputText 的 promptText、maxLength、restrict、password、keyboardType |
| `fgui_get_mask_settings` / `fgui_set_mask_settings` | 当前根，无 target；修改 settings, save=false | maskId、reversedMask，空 ID 清除；引用必须是直属对象 |
| `fgui_get_group` / `fgui_set_group` | target；修改 `group_id`, save=false | 设置同层分组，空串解除，拒绝循环 |
| `fgui_get_relations` / `fgui_add_relation` / `fgui_remove_relation` | target；修改 `relation_type`, `relation_target_id=parent`, `use_percent=false`（add）, save=false | 读取可用类型；增删单条关系并保留同目标其它关系，拒绝循环和继承只读关系 |
| `fgui_get_loader` / `fgui_set_loader` | target；修改 `settings`, save=false | 二维 Loader：`fill`、`align/vAlign`、`autoSize`、`shrinkOnly`、`useResize` |
| `fgui_verify_document` | `max_depth`, target?, `expected?`, `read_xml=true`, `include_tree?` | 无 expected 为快照；有 expected 时默认省略树，仅比对 Editor/磁盘 XML |
| `fgui_insert_object` / `fgui_remove_object` | 资源 URL、坐标 / 目标 | 插入已有资源或删除非根对象 |
| `fgui_get_loader3d` / `fgui_set_loader3d` | 对象定位；读取 `include_asset_info=true`；修改 `resource_url?`, `animation_name?`, `skin_name?`, `playing?`, `loop?`, `frame?`, `save=false`, `verify=true`, `skip_name_validation=false`, `fix_spine=true` | 读取/修改直属 Loader3D 的包内 Spine；省略保持，空字符串清除 |
| `fgui_fix_spine_anchor` | `url?` 或 `package_name` + `item_name/item_path` | 修复 Spine 包围盒、锚点及 PMA，保存包元数据 |
| `fgui_capture_document` | `scale=1`, `expected_document_url?` | 当前组件 PNG；MCP 返回图像块，CLI 返回文件元数据 |
| `fgui_get_controllers` / `fgui_create_controller` | 无 / `name`, `page_names?`, `save=false` | 读取根控制器/页面/当前页；创建空或有初始页面的控制器 |
| `fgui_add_controller_page` / `fgui_rename_controller_page` | `controller_name`, `name`, `save=false`；重命名另需页面定位 | 末尾追加或保留 ID 改名 |
| `fgui_set_controller_page` | `controller_name`, `page_id/page_name/page_index` 三选一, `save=false` | 原生切页，应用 Gear/联动，不修改 homePage |
| `fgui_get_component_instance` | object_id/object_path/object_name 三选一 | 读取直属实例的控制器、exported/alias、覆盖页和自定义属性覆盖/实际值 |
| `fgui_set_component_instance_controller` | target、controller_name、page_id/page_name/page_index 三选一、save=false | 为已导出的控制器设置实例覆盖，只保存父文档 |
| `fgui_set_component_instance_property` | target、child_path、property_id=0/1、value（字符串）、save=false | 已暴露文本/图标的实例覆盖；内部点分路径；空串可用，null 拒绝 |
| `fgui_get_component_properties` | 无 | 当前根组件的文本/图标属性定义 |
| `fgui_upsert_component_property` / `fgui_remove_component_property` | child_path、property_id=0/1、save=false；upsert 另传 label? | 创建/修改/删除定义映射；省略 label 保留，空串清空；不删除内部元件 |
| `fgui_set_controller_properties` | controller_name、settings={exported?,alias?}、save=false | 当前根控制器导出为组件属性及备注，保留页面与联动 |
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

- **计划与性能**：批量只操作一个活动文档，必须匹配 revision；允许操作/原生参数见[计划示例](editing-plans.md)。ref 仅用于创建，引用必须向后使用；Editor 分配 ID。dry_run 只预检结构/作用域/引用，动态原生约束执行时校验。单步保存、导入发布、切换文档、任意脚本均禁止。失败停止、不自动保存/回滚；同操作键同参数只返回回执，不重复创建。回执仅限同 Editor 进程，unknown/running 不代表可安全重试。
- **外部编辑与预览**：已授权界面任务可自主编辑源 XML，无需单独许可。Editor 持有文档时交接干净文档，令牌绑定原生实例和完整快照，有新内容时拒绝重载；allow_unchanged_dirty 只能在完整快照一致时显式使用。确认无人持有或独占隔离工程时可离线编辑并校验，不能把 MCP 离线视为无人持有。因缺少工具接口而改用 XML，最终报告必须列出具体缺口、原因、修改路径/行号与范围、检查及重载结果、未验证事项和补齐建议。多状态截图逐状态从原控制器基线开始，finally 恢复并回读完整快照；只适用普通设计编辑态，不承诺恢复运行预览业务副作用。

- **原生编辑**：只修改当前文档直属对象，嵌套定义先打开所属组件；ScrollPane 仅允许根组件或原生 List。按钮绑定引用父控制器名称和稳定页面 ID，不重写父控制器首页。分组边界由成员决定，空分组不会被 Editor 保存；创建并保存时需传成员。新接口实际修改清除旧 Agent 历史，无完整结构撤销，失败返回可能已发生的修改，不伪称回滚。
- **布局配置**：List layout 为 `column/row/flow_hz/flow_vt/pagination`，repeatX/Y 为列数/行数（0 自动计算），分页还需配置 ScrollPane。overflow 为 `visible/hidden/scroll`，scroll 为 `horizontal/vertical/both`，scrollBarDisplay 为 `default/visible/auto/hidden`；pageMode 只修改对应位并保留其它 scrollBarFlags。Loader fill 为 `none/scale/scaleMatchHeight/scaleMatchWidth/scaleFree/scaleNoBorder`，`scale` 为等比适配。
- **文本与几何**：文本支持 font/fontSize/color、align/vAlign/autoSize、lineGap/letterSpacing、text、bold/italic/underline/strike、stroke/strokeColor/strokeSize、shadow/shadowColor/shadowX/shadowY、ubbEnabled/varsEnabled/singleLine、outlineSoftness/underlaySoftness/faceDilate，效果以宿主和字体实际支持为准。描边/阴影参数需启用对应效果。批量坐标/尺寸与文本样式按固定顺序写入，拒绝与自动尺寸或 useSourceSize 冲突；不自动关闭调用方未指定的约束。验证支持描边、阴影、UBB 默认省略和组件引用默认尺寸，保留 `externalReload=false` 的接口语义。

- **页面与作用域**：Controller/Action 属于当前文档根组件，Gear 属于直属子对象；联动可引用当前/直属子组件控制器，不改子组件资源。页面定位三选一，优先稳定 ID；名称不允许空白、逗号或控制字符，同一控制器中新页面名称不能重复。创建有页面的控制器或向空控制器追加首页时自动选中第一页。切页不修改 homePage，重开可能按首页规则重选。
- **实例与定义**：`get_controllers` 额外返回 exported/alias。实例值用 `get_component_instance` 及两个实例 setter；组件定义用三个 component_property 工具，控制器导出用 set_controller_properties。只暴露原生文本/图标，拒绝无效/重复路径；不等于 `customData`。详见[组件属性说明](component-properties.md)。
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
- Loader3D、Controller、Gear、Action 与原生编辑接口默认不保存，实际编辑清空旧 Agent 历史，无完整撤销；无变化且不保存时保留历史。`save=true` 保存整个组件并回读 XML；Gear 校验目标全部 Gear，Action 校验内容和顺序，原生编辑核对 Editor 自己的序列化快照。图片九宫格保存作用于整个包并影响所有引用。保存失败报告磁盘状态，不声称成功或完整回滚；保留 `error.details`。
- SpineFixer 只接受已验证的 Spine 4.2 二进制 .skel 有效导出包围盒，修复尺寸/锚点并设置 pma=false，回读 package.xml。绑定 resource_url 或插入 Spine 默认修复并保存所属包，独立于组件 save=false，不能用文档 undo/discard 回退；`resourceFix` 单独报告。`fix_spine=false` / `--no-fix-spine` 可跳过，只读及仅播放属性调整不修复，不提供 Spine 导入。
- 截图需实际观察，资源、布局、遮挡与可见性大体正确即可。成功为 pending_review；缺图/坏图返回 manual_required，要求用户自行验证，保留修改，不自动回滚。结构、持久化和视觉结论分别报告；对象树存在 Spine 不等于已捕获其图像。
- 截图范围：scale<=4、单边<=4096、总像素<=8388608、PNG<=16 MiB；仅写 `.agent/captures/`，一天前的本工具截图会清理。
- 发布前先用 `fgui_get_publish_settings`。发布期间桥接会阻止资源、动画及文档写操作。

## CLI 映射

正式子命令包括：

- 基础：`status`、`ping`、`project`、`packages`、`items`、`open`、`active`、`tree`、`select`、`set`、`insert`、`remove`
- 资源：`create-component`、`create-button`、`import-image`、`import-font`、`import-sound`、`create-movieclip`、`get-movieclip`、`update-movieclip`、`remove-movieclip`、`get-loader3d`、`set-loader3d`、`fix-spine-anchor`
- Transition：`transitions`、`get-transition`、`upsert-transition`、`remove-transition`、`add-transition-item`、`update-transition-item`、`remove-transition-item`
- 计划与交接：`get-objects`、`apply-batch PLAN.json`、`get-batch-result`、`capture-states`、`begin-external-edit`、`finish-external-edit`、`diagnostics`。批量计划字段使用 Bridge camelCase，全局 --timeout 仍在命令前。
- 属性与验证：`replace-object-resource`、`get-text-style`、`set-text-style`、`set-properties`、`verify-document`、`capture-document`
- 原生布局：`create-object`、`get-image-settings/set-image-settings`、`get-button-binding/set-button-binding`、`get-list-settings/set-list-settings`、`get-scroll-settings/set-scroll-settings`、`get-loader/set-loader`、`get-group/set-group`、`get-relations/add-relation/remove-relation`
- 列表项：`get-list-item-resources`、`set-list-item-resources SETTINGS_JSON`；`--id/--path/--name` 定位直属 List，写入支持 `--save`。
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
- Windows Editor 6.1.4 已有隔离实测，未覆盖所有对象/业务组合；不等于业务工程发布和 Unity/设备验收。实现和自动回归入口见 `plugin/` 与 `tests/`；临时验证报告和截图仅本地保存，不纳入 Git。

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
