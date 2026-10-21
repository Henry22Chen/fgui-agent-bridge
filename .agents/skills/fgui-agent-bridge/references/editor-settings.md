# Editor 分组、输入框、遮罩和资源替换

这些能力需要插件与客户端 `0.13.0` 或更高版本。六个新工具与两个既有工具扩展均使用 Editor 原生 API。默认不保存；`save=true` 保存整个当前组件并核对原生 XML，没有完整 Agent 撤销，失败不自动回滚。

## 分组高级模式

先 `fgui_get_group_settings(target)`，再 `fgui_set_group_settings(settings, target, save=false)`。这是分组本身的设置；成员归属仍使用 `fgui_get_group` / `fgui_set_group`。

| 字段 | 约定 |
|---|---|
| advanced | 布尔值，开启/关闭高级模式 |
| layout | `none`、`hz`、`vt`，分别为无布局、水平、垂直 |
| lineGap / columnGap | 数值，行间距/列间距 |
| excludeInvisibles | 排除不可见成员 |
| autoSizeDisabled | 禁用自动尺寸 |
| hasMainGrid | 是否启用主格 |
| mainGridIndex | 当前组成员的从 0 开始索引，启用主格时必须有效；关闭主格时不同时传索引 |

高级布局会根据原生规则重新排列成员；关闭高级模式保留 Editor 中已有的布局参数。原生 `mainGridMinSize` 不写入组件 XML，因此不作为可持久化设置开放。

## 输入框提示

使用 `fgui_get_input_settings(target)` / `fgui_set_input_settings(settings, target, save=false)`。仅支持当前文档直属 InputText，普通 Text/RichText 在写入前拒绝。

| 字段 | 约定 |
|---|---|
| promptText | 提示字符串，可包含 Editor 支持的 UBB；空串清除 |
| maxLength | 非负整数，0 不限制 |
| restrict | 字符限制字符串，空串清除 |
| password | 布尔值 |
| keyboardType | Editor 键盘类型枚举的非负整数 |

提示不是输入内容，不改 `text`。原生空提示与空限制重载后可能是 null，读取接口统一返回空字符串。

## 根组件遮罩

根 margin、尺寸限制、hitTestSourceId 以及扩展滚动设置在 `0.17.0` 开放，见[容器与滚动](container-scroll.md)。命中区域与下述遮罩分别设置。

`fgui_get_mask_settings()` 无对象定位参数，读取当前根组件；`fgui_set_mask_settings(settings, save=false)` 接受：

```json
{"maskId":"直属对象ID","reversedMask":true}
```

`maskId` 必须引用当前文档的直属可显示对象，拒绝根自身、嵌套对象、分组和不存在的 ID。空串解除遮罩，同时清除反向标志。没有遮罩时不能启用反向遮罩。它只改变引用与标志，不修改被引用对象的图形或资源。

## 列表发布清空示例项

`fgui_get_list_settings` 返回 `clearOnPublish`；`fgui_set_list_settings(settings={"clearOnPublish":true})` 控制发布时是否清空示例项，对应组件源 XML 的 `autoClearItems`。不删除 Editor 中的预置项，预置项编辑仍使用列表项资源接口。

## 组件实例资源替换

`fgui_replace_object_resource(resource_url, target, expected_type="", preserve_size=true, save=false)` 支持 Image/Loader 图片和当前文档直属组件实例。`expected_type` 为空时按目标推断，非空必须为匹配的 `image` 或 `component`。拒绝根组件、嵌套对象、类型不匹配和当前组件自身引用。

组件替换调用原生 `Document.ReplaceSelection`，按稳定 ID 重新取回新实例。默认保留宽高；外层 ID、名称、位置、Pivot、缩放、旋转、透明度、可见/交互、分组、Gear 和 Relation 在替换后核对。返回 `before/after` 中的 `outer`、`bindings` 和 `overrides`。内部子对象、导出属性与控制器覆盖遵循 Editor 原生替换语义，旧路径不保证继承；需要继续设置时重新读取 `fgui_get_component_instance`。组件保存始终核对完整文档 XML。

## CLI 与批量

```bash
fgui-agent set-group-settings --id groupID '{"advanced":true,"layout":"hz","columnGap":8}' --save
fgui-agent set-input-settings --id inputID '{"promptText":"请输入","maxLength":12}' --save
fgui-agent set-mask-settings '{"maskId":"maskID","reversedMask":false}' --save
fgui-agent set-list-settings --id listID '{"clearOnPublish":true}' --save
fgui-agent replace-object-resource --id componentID ui://packageIdresourceId --expected-type component --save
```

`get-mask-settings` 无 target；其余新读取命令使用 `--id/--path/--name`。资源替换可传 `--no-preserve-size` 取消 Bridge 的显式尺寸恢复，尺寸遵循 Editor 原生替换行为（可能仍保留原尺寸）。

批量新增 `set_group_settings`、`set_input_settings`、`set_mask_settings` 和 `replace_object_resource`；使用 camelCase 原生参数，单步禁止 save，仅允许整批保存。遮罩 `settings.maskId` 使用稳定对象 ID。旧插件在入队前被能力协商拒绝，包括旧 `set_list_settings` 中新增字段及组件替换；请同步插件并重新加载，不改用重复写入来排查超时。
