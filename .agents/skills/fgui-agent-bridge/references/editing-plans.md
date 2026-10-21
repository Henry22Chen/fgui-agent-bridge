# 批量计划与集中校准

先确认目标工程和组件，再一次读取需要的对象。使用 `fgui_get_objects(document_url, targets, fields)`，例如 targets 为 `[{"name":"title"},{"id":"n10"}]`，fields 为 `["x","y","width","height","text"]`。返回 revision 是当前原生文档的进程内标识，不能自行编造；空 targets 可只取得 revision。

一次提交的 MCP 参数示例（替换真实 URL/revision）：

```json
{
  "document_url": "ui://packageIdresourceId",
  "expected_revision": "从 get_objects 返回",
  "operation_key": "reward-layout-r1",
  "operations": [
    {"action":"create_object","ref":"caption","params":{"objectType":"text","name":"rewardCaption","x":20,"y":30,"width":180,"height":40}},
    {"action":"set_text_style","params":{"target":{"id":"$caption"},"style":{"text":"奖励","fontSize":30,"color":"#FFFFFF","autoSize":"none"}}},
    {"action":"set_properties","params":{"target":{"name":"ExistingButton"},"properties":{"x":20,"y":100,"width":300,"height":100}}}
  ],
  "save": false,
  "verbose": false
}
```

`params` 是原生 Bridge 参数名（camelCase），不是单工具的 Python 参数名。`target` 必须且只能有 id/path/name 一个字段。操作级 ref 只标记创建/插入操作；复制改用 params.refs={源ID:别名}。后续 target.id、targets[].id、groupId、relationTargetId、groupMemberIds、orderedIds 和 names/refs 的源键可以使用 `$ref`，不支持前向引用；文本中出现 `$` 不会被替换。复制的展开成员与全序清单示例见[对象结构编辑](object-structure.md)。

| action | params |
|---|---|
| create_object | objectType, name?, x?, y?, width?, height?, insertIndex?, groupMemberIds? |
| insert_object | url, name?, x?, y?, insertIndex?；仅已有 Image/Component，不触发复杂资源修复 |
| duplicate_objects | targets, offset?, namingPolicy?, names?, externalReferences?, refs?；根下对象、组展开；禁止操作级 ref |
| reorder_objects | orderedIds；必须覆盖执行时全部直属对象的最终有序 ID |
| set_properties / set_text_style | target, properties / style |
| set_button_binding / set_list_settings / set_scroll_settings / set_loader / set_group_settings / set_input_settings | target, settings |
| set_list_item_resources | target, settings={defaultItem?,items?}；sourceIndex 基于调用前清单，树 level 为0起始前序，详见[列表与树](list-items.md) |
| set_button_settings | target, settings；仅直属按钮实例覆盖，禁止根定义和状态资源编辑 |
| set_graph_settings / set_image_display / set_filter_settings | target, settings；图形/图片显示/颜色滤镜 |
| set_mask_settings | settings={maskId?,reversedMask?}；作用于根组件，无 target |
| set_container_settings | settings={margin?,minWidth?,maxWidth?,minHeight?,maxHeight?,hitTestSourceId?}；当前根，无 target；hitTestSourceId 可用前序 `$ref` |
| replace_object_resource | target, resourceURL, expectedType?, preserveSize?；图片或组件实例 |
| set_group | target, groupId |
| add_relation / remove_relation | target, relationTargetId?, relationType, usePercent?（仅 add） |
| set_gear | target, gearType, controllerName, defaultValue?, pageValues?, visiblePageIds? |
| create_controller | name, pages? |
| set_controller_page | controllerName, pageId/pageName/pageIndex 三选一 |
| set_controller_properties | controllerName, settings={exported?,alias?} |
| set_component_instance_controller | target, controllerName, pageId/pageName/pageIndex 三选一；需已导出 |
| set_component_instance_property | target, childPath, propertyId=0/1, value（字符串） |
| upsert_component_property / remove_component_property | childPath, propertyId=0/1；upsert 可选 label；作用于当前根定义 |
| remove_object | target；不能删除根 |

先用 dry_run=true 可以预检查结构、作用域和引用，不产生回执或修改。它不能提前模拟所有原生自动布局/Gear 约束。正式执行失败会停止，已经完成的操作保留且不自动保存，不是原子回滚。

`set_scroll_settings` 扩展的 scrollBarMargin、clipSoftness、滚动条/头尾资源也可批量；Python 在入队前校验 scroll_settings_extended 能力标记。根 pageControllerName 不能绑定自身控制器，直属 List 可绑定父文档控制器。完整模式和有名边距规则见[容器与滚动](container-scroll.md)。

列表与树沿用两个写 Action：先 set_list_settings 开树模式，再 set_list_item_resources 提交合法最终层级；关闭树模式前先显式把所有 level 设为0。新 List 可用 target.id="$ref" 串联两步。0.18.0 的列表高级字段和 items.level 分别校验 list_settings_advanced/list_item_levels 能力，旧插件在批量入队前拒绝。dry_run 不模拟前序变更后的原生树结构，执行失败仍保留前缀，先查回执。

正式执行检查 status=succeeded。失败或超时后，使用原 document_url + operation_key 调用 `fgui_get_batch_result`。相同键、相同参数再次提交只返回原回执；修改参数必须换新键。verbose=true 返回逐操作详情，默认只返回状态、计数、别名 ID 和错误。unknown/running 不证明操作未执行；Editor 重启后回执属于旧实例，必须先检查实际文档，不能盲目重试。

save=true 只在整批成功后保存整个当前组件并核对 XML；它也会包含该组件原有未保存内容。批量不允许单步 save、导入、发布、任意脚本或切换文档，不提供完整 Agent undo。

集中视觉校准使用 `fgui_capture_states`，例如：

```json
{
  "document_url":"ui://packageIdresourceId",
  "states":[
    {"label":"未派遣","controllers":{"SendingStatus":"0","RewardType":"0"}},
    {"label":"派遣中","controllers":{"SendingStatus":"1","RewardType":"1"}}
  ],
  "scale":0.5,
  "columns":2
}
```

所有页面先验证，每一状态都从原控制器基线开始；finally 恢复指定控制器并比较完整原生快照。联系图用序号标注，metadata 保留完整标签及原图路径，放大时读取原图。恢复失败/缺图要人工核对，不保存、不自动放弃。这里只适用于普通设计编辑态。

用户已授权界面制作或修改任务时，可自主选择直接编辑源 XML，无需另行申请 XML 编辑许可；用户明确禁止 XML 时遵守其限制。只读分析可直接读取 XML。

- Editor 持有目标文档时，先 `fgui_begin_external_edit` 取得干净文档的 token、文件路径和完整快照；写入后 `fgui_finish_external_edit` 对同一原生文档检查快照，再重载并回读。令牌一次性使用，`allow_unchanged_dirty` 不能绕过快照比较。
- 确认没有 Editor 持有目标文档，或使用独占隔离工程时，可离线修改 XML，不要求先安装 MCP。MCP 离线或连接失败本身不能证明文档无人持有。写入前记录原文或差异并检查并发变化，写入后验证语法、对象 ID、资源引用及必要的 package.xml 登记。
- 用户未保存内容、来源不明的 dirty 状态或并发变化不能自动保存、丢弃或覆盖；暂停该文档，继续其他独立工作。任务所需保存和重载在既有授权内执行，发布仍按用户授权范围处理。

因 MCP 缺少对应工具接口而改用 XML 时，在最终完成报告中单列“工具能力缺口”，写明缺少的具体接口/能力、替代原因、实际修改的相对路径/行号及对象/字段范围、检查结果、Editor 是否重载、未验证事项和接口补齐建议。连接故障、旧版本未加载、参数错误和现有接口限制须按实际原因报告，不能误报成接口不存在。

制作前用 `uv run python scripts/inspect_design_assets.py 切图目录` 取画布、alpha 可见边界及透明内边距；可选 `uv sync --extra design` 后读取 PSD 图层 bbox 和文字。先统一画布/缩放/字体、保留控件契约，再批量执行和集中对比，避免凭截图反复猜透明素材尺寸。

`fgui_diagnostics` 只记录本 MCP 进程最近请求的 readinessMs、requestWaitMs、roundTripMs、请求/响应字节及 Editor queueWaitMs/executionMs。调用端分发和模型耗时不在计时范围内；CLI 独立进程的 diagnostics 不会读取其他 MCP 进程历史。

CLI 的 apply-batch 接收 JSON 文件，上述 document_url/expected_revision/operation_key 在文件中分别写 documentUrl/expectedRevision/operationKey，其余使用相同操作结构；全局参数放在子命令前。
