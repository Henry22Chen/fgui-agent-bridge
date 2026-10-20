# 列表项资源与预置项属性

本能力需要 Bridge/插件 `0.12.0`（Git 标签 `v0.12.0`），协议仍为 `2.0`。调用前先确认 MCP 与插件版本、工程、活动文档，并读取目标 List。

## 接口与作用范围

- `fgui_get_list_item_resources(object_id? / object_path? / object_name?)`：返回 `settings.defaultItem` 和有序 `settings.items`。
- `fgui_set_list_item_resources(settings, object_id? / object_path? / object_name?, save=false)`：编辑当前文档直属原生 List 的资源与预置项，不修改引用的组件定义。
- CLI：`get-list-item-resources --id ID`、`set-list-item-resources SETTINGS_JSON --id ID [--save]`。
- 批量 Action：`set_list_item_resources`，参数为 `{target,settings}`；target 支持已创建 List 的 `$ref`，保存由批量计划统一控制。

这里编辑的是 Editor 预置项，不是运行时虚拟列表的数据或 `itemRenderer`。

## 默认资源和最终有序清单

`settings` 只能包含 `defaultItem`、`items`，至少提供一个。资源 URL 必须解析为工程内组件；命名 URL 会规范化为 ID URL。空 `defaultItem` 清除默认资源；已有项若继承默认资源，则必须同时提供显式资源或移除该项。

`items` 省略时保留全部预置项；提供时完整替换最终清单（最多 10000 项）：

- `sourceIndex` 为调用前原列表的从零索引，复制原项并保留未提供的字段。所有索引都基于同一份原列表；也可重复引用以复制一项。
- 无 `sourceIndex` 创建新项，省略 `url` 或传 `url=""` 时继承默认项；有非空 `url` 时单独引用组件资源。
- 原列表中未被引用的项删除；清单顺序就是最终顺序；`items=[]` 删除全部预置项。
- 每项最终都必须有可解析的显式或默认资源，不能引用当前组件自身。

只替换默认项资源：

```json
{"defaultItem":"ui://实际包ID实际组件ID"}
```

假设原列表有 3 项，下面保留第 2 项并移到首位，新增一项，再保留第 0 项；原第 1 项删除：

```json
{
  "items": [
    {"sourceIndex":2},
    {"url":"ui://实际包ID实际组件ID","name":"newItem","title":"新条目"},
    {"sourceIndex":0,"title":"保留项的新标题"}
  ]
}
```

## 预置项属性与覆盖

每项可编辑 `url`、`name`、`title`、`icon`、`selectedTitle`、`selectedIcon`、`properties`。文本和图标字段均为字符串：省略保留，空字符串清空，不接受 `null`。`url=""` 则恢复继承默认资源。

`properties` 是该项的完整覆盖数组：省略保留；`[]` 清除所有内部属性与控制器覆盖。每项为 `{target,propertyId,value}`：

| propertyId | target | value |
| --- | --- | --- |
| `-1` | 控制器名称 | 页面 ID 字符串，例如 `"0"` |
| `0` | 内部文本对象路径，例如 `label` 或 `container.label` | 文本字符串，含空串 |
| `1` | 内部图标对象路径 | 图标字符串，含空串 |

同一项不能重复声明相同 target/propertyId。覆盖值使用原生 `ListItemData/ComProperty`；调用方应根据引用组件的实际路径和页面 ID 提供覆盖，不会为它新增暴露定义、页面或内部对象。

```json
{
  "items": [
    {
      "sourceIndex":0,
      "title":"",
      "selectedTitle":"已选择",
      "properties":[
        {"target":"label","propertyId":0,"value":"条目内容"},
        {"target":"State","propertyId":-1,"value":"0"}
      ]
    },
    {"sourceIndex":1},
    {"sourceIndex":2}
  ]
}
```

读取结果包含 `index`、原始 `url`、`effectiveUrl`、名称/标题/图标、保留的树层级 `level` 与覆盖数组。`effectiveUrl` 只用于解释继承，`index/effectiveUrl/level` 不是写字段；不要将整个读取结果直接当写入清单。修改项时用 `sourceIndex` 指明要保留的原项。

## 校验与保存边界

先在临时原生 ListItemData 副本中检查全部字段、资源、索引及重复覆盖，再统一设置 `FList.defaultItem/items`；错误参数不会先修改原项或默认资源。通过 `FList.items` 原生 setter 重建 Editor 子项，应用后回读核对完整清单。

默认不保存。`save=true` 保存整个当前组件，并按 Editor 原生序列化结果核对磁盘 XML。沿用现有布局接口的撤销边界：没有完整 Agent 事务撤销，Editor 拒绝或保存失败不自动回滚，响应会报告可能已发生的修改。发布期间拒绝写入。批量操作失败可能部分执行，超时先查批量回执。
