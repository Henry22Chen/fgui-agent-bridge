# 组件实例覆盖与属性定义

本能力需要 Bridge/插件 0.11.0。实例配置与源组件定义分开处理，不能用修改共享定义的方式替代单实例覆盖。

0.20.0 另扩展首页规则、autoRadioGroupDepth、控制器/页面生命周期及引用预览，见[控制器生命周期](controller-lifecycle.md)；本页保留实例覆盖与导出定义的约定。

## 实例配置

父文档中选定直属组件实例，用 `fgui_get_component_instance(object_id=...)` 读取：

- `controllers`：页面、当前页、exported/alias、overridden、overridePageId。私有控制器可读取，但不开放实例覆盖写入。
- `properties`：target、propertyId、label、value（null 表示未覆盖）、overridden、effectiveValue。损坏或过期映射返回 resolutionError，读取不修改文档。

`fgui_set_component_instance_controller(controller_name="State", page_id="1", object_id="n1")` 设置已导出的控制器。也可用 page_name 或 page_index，必须三选一，优先稳定页面 ID。原生 ComProperty 的覆盖值和当前选中页一起检查；联动重定向会报错，不能只改 selectedIndex 后声称已持久化。

`fgui_set_component_instance_property(child_path="label", property_id=0, value="购买", object_id="n1")` 设置已暴露属性；`child_path="inner.caption"` 支持内部嵌套路径。property_id=0 为文本，1 为图标，value 为原始字符串（不是 JSON），空串可以表示清空文字/图标。

不接受 value=null 或未暴露的属性。Editor 的 ApplyCustomProperty(null) 会移除 XML 覆盖但不恢复当前显示值，本接口暂不提供清除覆盖/恢复继承，避免把两者混为一次成功操作。可显式设置所需值。

两个 setter 默认不保存，save=true 保存整个父文档并回读完整原生 XML，不改共享组件文件，也不改其他实例。内部文本/图标仍可能受 Gear、自动尺寸和联动约束，失败不自动回滚。

## 组件定义

打开源组件文档后：

- `fgui_get_component_properties()` 读取当前根组件的映射列表。
- `fgui_upsert_component_property(child_path="label", property_id=0, label="文案")` 创建或修改一个定义。路径逐层检查存在且名称唯一，末端必须支持相应文本/图标属性；不会改默认值。
- `fgui_remove_component_property(child_path="label", property_id=0)` 移除定义，保留内部元件；缺失为无变化。不会扫描或清理其他文档实例已有覆盖。
- `fgui_set_controller_properties(controller_name="State", settings={"exported":true,"alias":"状态"})` 设置“导出为组件属性”和备注名。空 alias 清空备注，不改页面、当前页或联动。`fgui_get_controllers` 也会返回这两个字段。

upsert 省略 label 保留已有备注，新定义默认为空；传空串清空备注。所有写入默认不保存，save=true 保存当前源组件并比对完整原生 XML。其他已打开父文档的实例元数据刷新遵循 Editor 原生行为；需要时重新打开父文档，不能覆盖其未保存修改。

## 批量与 CLI

五个写操作均可放入 fgui_apply_batch，params 使用 Bridge camelCase，单步禁止 save；创建/插入组件后的 target.id 可以使用 $ref。定义操作始终作用于当前根文档，不接受实例 target。

```json
[
  {"action":"insert_object","ref":"button","params":{"url":"ui://真实资源URL","name":"BuyButton"}},
  {"action":"set_component_instance_controller","params":{"target":{"id":"$button"},"controllerName":"State","pageId":"1"}},
  {"action":"set_component_instance_property","params":{"target":{"id":"$button"},"childPath":"label","propertyId":0,"value":"购买"}}
]
```

CLI 使用同名连字符命令：get-component-instance、set-component-instance-controller、set-component-instance-property、get-component-properties、upsert-component-property、remove-component-property、set-controller-properties。实例定位用 --id/--path/--name；控制器选择用 --page-id/--page-name/--page-index；定义备注用 --label；保存用 --save。例如：

```bash
fgui-agent --project /ABS/Project.fairy set-controller-properties State '{"exported":true,"alias":"状态"}' --save
fgui-agent --project /ABS/Project.fairy set-component-instance-property label 0 '购买' --id n1 --save
```

这些功能不是 customData：后者仍使用通用属性工具写原始字符串，不参与组件自定义属性定义。
