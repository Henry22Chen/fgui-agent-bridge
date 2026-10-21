# 对象复制与显示层级

需要 Bridge、插件 **0.16.0** 或更高版本。新增 duplicate_objects、get_child_order、reorder_objects 三个 MCP 工具及 CLI；复制和重排也可批量。默认不保存，save=true 保存整个当前组件并核对完整原生 XML，无完整结构撤销。

## 完整层级

`fgui_get_child_order()` 返回当前文档根下完整 order、每个对象的 ID/名称/类型/index/groupId/resourceURL、revision 和 childrenRenderOrder/apexIndex。

`fgui_reorder_objects(ordered_ids, save=false)` 的清单必须覆盖全部当前直属对象，ID 不能重复、遗漏、来自其他文档或指向内部子对象。返回 beforeOrder/afterOrder。将目标 ID 移到清单末尾或开头，可在常规 ascent 模式置顶或置底。

这是 child index 顺序；工具不更改自定义的 ascent/descent/arch 渲染方式。逻辑组成员仍是根下直属对象，groupId 与 child index 独立。保存重载和截图分别验证实际顺序与绘制效果。

## 复制参数与作用域

`fgui_duplicate_objects` 只复制当前根下的对象，必须先退出组内部编辑状态；不复制根或嵌套组件内部对象。选择 Group 时自动展开全部直属成员及嵌套逻辑组成员，按原显示顺序复制；展开后最多 200 个对象，拒绝空组和循环分组。

| 参数 | 合约 |
|---|---|
| targets | 1..200 项，每项仅 id/path/name 之一，不能重复定位同一源对象；组展开的重叠成员只复制一次 |
| offset | {x,y}，省略或缺少轴为 0；有限数字、绝对值不超过 1000000，按 Editor 三位小数精度规范化 |
| naming_policy | auto_rename 默认；缺省候选为原名_copy，冲突时加 _2、_3 等；error 在分配 ID 前拒绝冲突 |
| names | 可选 {源ID:新名称}，可指定展开成员；名称不可为空、超过 200 字符或包含路径/控制字符 |
| external_references | reject 默认；preserve 明确保留集合外的 Relation 和 groupId；不存在的引用始终拒绝 |
| refs | 可选 {源ID:别名}，仅本次复制集合；别名唯一、以字母开头，最多32位字母数字/下划线/横线 |
| save | 默认 false；true 保存整个当前组件 |

内部 Relation 和分组引用重映射到克隆。父级 Relation 仍指向当前根。显式保留外部 groupId 会将克隆加入原组，可能改变原组边界/布局；结果报告 externalReferences 和 affectedOriginalIds，不静默断开引用。

复制使用原生 InsertObject 分配 ID，再用原生 Read_beforeAdd/Read_afterAdd 载入对象配置。所有 ID 就绪后绑定引用、刷新组边界并核对快照。**不读写系统剪贴板**，不导入或复制包资源文件，不触发 Spine 资源修复。组件实例仅复制父文档覆盖，共享源不改。

对象 ID 在各自组件内唯一，嵌套实例/List 内部可能与根对象重名。ID 定位优先当前层直属对象，访问内部对象应使用明确路径；写操作仍受直属对象边界限制。

位移同时作用于坐标及 GearXY 的默认值/全部页面值，GearXY 的非零位移必须保持整数；百分比位置 Gear 暂只接受零偏移。其它 Gear、样式和实例覆盖保持。根控制器、文档 Transition、遮罩和自定义属性映射保留原目标，不自动指向克隆。

结果包含 created、idMap、aliases、requestedIds、expandedSourceIds、beforeOrder/afterOrder、externalReferences、affectedOriginalIds、clipboardTouched=false。原生中途失败返回真实 createdIds/idMap 和实际顺序，不自动回滚；超时不能盲目再次复制，优先用批量及回执保护。

## 批量别名

duplicate_objects 不允许操作级单一 ref。使用 params.refs 按源 ID 声明多对象别名，后续 target.id、targets[].id、names/refs 的源键以及 orderedIds 可引用 `$别名`。组成员需要参与后续重排时，应给每个展开成员分配别名。别名不能重名、覆盖前序别名或前向引用。

```json
{
  "operations": [
    {"action":"duplicate_objects","params":{"targets":[{"id":"oldImage"}],"offset":{"x":20,"y":0},"refs":{"oldImage":"newImage"}}},
    {"action":"set_properties","params":{"target":{"id":"$newImage"},"properties":{"name":"NewImage"}}},
    {"action":"reorder_objects","params":{"orderedIds":["oldImage","anotherOriginal","$newImage"]}}
  ]
}
```

补充真实 document_url、expected_revision、唯一 operation_key；禁止单步 save，整批保存。重排清单仍须覆盖执行到该步骤时的所有对象。dry_run 只检查静态结构和已有引用，不能完整模拟前序创建后的原生布局和数量；失败保留已执行前缀，先查回执。

## CLI

```bash
fgui-agent get-child-order
fgui-agent duplicate-objects '[{"id":"groupId"}]' --offset-x 200 --save
fgui-agent duplicate-objects '[{"id":"objectId"}]' --external-references preserve --names '{"objectId":"NewName"}' --save
fgui-agent reorder-objects '["firstId","secondId","lastId"]' --save
```

编辑器设计态的叠放、保存 XML、原生发布和游戏实际渲染是不同证据。工具不改变游戏运行时排序代码，也不把普通结构操作描述为完整事务。
