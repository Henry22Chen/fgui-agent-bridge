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

`params` 是原生 Bridge 参数名（camelCase），不是单工具的 Python 参数名。`target` 必须且只能有 id/path/name 一个字段。ref 只标记创建/插入操作，后续 target.id、groupId、relationTargetId、groupMemberIds 可以使用 `$ref`，不支持前向引用；文本中出现 `$` 不会被替换。

| action | params |
|---|---|
| create_object | objectType, name?, x?, y?, width?, height?, insertIndex?, groupMemberIds? |
| insert_object | url, name?, x?, y?, insertIndex?；仅已有 Image/Component，不触发复杂资源修复 |
| set_properties / set_text_style | target, properties / style |
| set_button_binding / set_list_settings / set_scroll_settings / set_loader | target, settings |
| set_group | target, groupId |
| add_relation / remove_relation | target, relationTargetId?, relationType, usePercent?（仅 add） |
| set_gear | target, gearType, controllerName, defaultValue?, pageValues?, visiblePageIds? |
| create_controller | name, pages? |
| set_controller_page | controllerName, pageId/pageName/pageIndex 三选一 |
| remove_object | target；不能删除根 |

先用 dry_run=true 可以预检查结构、作用域和引用，不产生回执或修改。它不能提前模拟所有原生自动布局/Gear 约束。正式执行失败会停止，已经完成的操作保留且不自动保存，不是原子回滚。

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

只有用户明确授权 XML 编辑时，才能 `fgui_begin_external_edit`：文档须干净，返回 token 与文件路径。外部脚本写入后 `fgui_finish_external_edit` 对同一原生文档检查完整内存快照，再重载磁盘。若有陌生内存修改则停止；显式 allow_unchanged_dirty 也不能绕过快照比较。令牌一次性使用，不覆盖/保存用户 XML。

制作前用 `uv run python scripts/inspect_design_assets.py 切图目录` 取画布、alpha 可见边界及透明内边距；可选 `uv sync --extra design` 后读取 PSD 图层 bbox 和文字。先统一画布/缩放/字体、保留控件契约，再批量执行和集中对比，避免凭截图反复猜透明素材尺寸。

`fgui_diagnostics` 只记录本 MCP 进程最近请求的 readinessMs、requestWaitMs、roundTripMs、请求/响应字节及 Editor queueWaitMs/executionMs。调用端分发和模型耗时不在计时范围内；CLI 独立进程的 diagnostics 不会读取其他 MCP 进程历史。

CLI 的 apply-batch 接收 JSON 文件，上述 document_url/expected_revision/operation_key 在文件中分别写 documentUrl/expectedRevision/operationKey，其余使用相同操作结构；全局参数放在子命令前。
