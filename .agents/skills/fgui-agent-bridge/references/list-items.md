# 列表高级设置、树结构与预置项属性

基础资源/预置项能力需要 Bridge/插件 `0.12.0` 或更高版本；高级列表、树设置及 level 写入需要 **0.18.0**。协议仍为 `2.0`，工具总数110，沿用既有接口。调用前确认版本、工程、活动文档并读取目标直属原生 List。

## 接口与作用范围

- `fgui_get_list_item_resources(object_id? / object_path? / object_name?)`：返回 `settings.defaultItem` 和有序 `settings.items`。
- `fgui_set_list_item_resources(settings, object_id? / object_path? / object_name?, save=false)`：编辑当前文档直属原生 List 的资源与预置项，不修改引用的组件定义。
- CLI：`get-list-item-resources --id ID`、`set-list-item-resources SETTINGS_JSON --id ID [--save]`。
- 批量 Action：`set_list_item_resources`，参数为 `{target,settings}`；target 支持已创建 List 的 `$ref`，保存由批量计划统一控制。

这里编辑的是 Editor 预置项，不是运行时虚拟列表的数据或 `itemRenderer`。

## 列表高级设置

`fgui_get_list_settings(target)` / `fgui_set_list_settings(settings, target, save=false)` 保留布局、行列/间距、对齐、autoResizeItem、selectionMode 和 clearOnPublish。新增字段如下：

| 字段 | 约定 |
|---|---|
| selectionController | 当前父文档控制器名称，非空须存在；空串解除。它和 ScrollPane 的 pageControllerName 是两个独立绑定 |
| foldInvisibleItems | 布尔值，布局时折叠不可见项 |
| scrollItemToViewOnClick | 布尔值，点击后将项滚入视野；保存配置不等于已验证实际点击/滚动物理 |
| treeViewEnabled | 布尔值，开启/关闭原生树列表模式 |
| indent | 0..1000000 整数，树每层缩进；需要先或同时开启树模式 |
| clickToExpand | 整数枚举：0不自动展开、1单击、2双击；需要树模式 |

只编辑当前文档直属 List；根、普通组件实例及嵌套 List 拒绝，先打开所属文档。绑定选择控制器按原生选择索引联动父控制器，不改页面定义，也不覆盖分页控制器/flags。设置后显式刷新原生布局，核对预置项及内部覆盖保持。

树开关、indent/clickToExpand 不应和纯设计态展开状态混淆。普通模式不序列化 indent/clickToExpand；关闭树后响应 inactiveTreeFields 会列出它们，重载按原生默认值（Editor6.1.4为15和0），不能把内存残留值当作保存成功。

## 树前序层级与模式切换

0.18.0 在既有 `items` 中增加 `level`：0..255 整数，首项必须为0，相邻项只能加深一级，可以退回任意已存在的父层。普通列表只允许0，防止原生保存时静默丢弃非零层级；切回普通列表前先在树模式显式把全部项 level 设为0，再关闭 treeViewEnabled。

文件夹由“下一项的 level 更深”推断，没有独立的空文件夹标志。层级数据是前序清单，`sourceIndex` 复制一个原项，不自动带上整个子树；移动子树时须按最终顺序列出全部后代。省略 level 保留原项层级，新增项默认0；删除/重排后仍须满足首层与不跳级规则。

`get_list_settings` 返回轻量 tree 摘要，`get_list_item_resources` 的顶层 `tree.nodes` 返回 `{index,level,parentIndex,isFolder}`。索引对应 `settings.items`，根项 parentIndex=null；这些是只读解释字段，不另造重复写接口。非法旧数据仍可读取，tree.valid=false 和 errors 指明错误位置，可用合法最终清单修复。

```json
{
  "items":[
    {"sourceIndex":0,"level":0,"title":"根 A"},
    {"sourceIndex":1,"level":1},
    {"level":2,"title":"孙节点"},
    {"sourceIndex":2,"level":1},
    {"level":0,"title":"根 B"}
  ]
}
```

原生文件夹默认展开（tree.nativeDefaultFolderExpanded=true），本版没有独立的逐项 expanded 持久化字段（expandedStateFieldAvailable=false），输入 expanded/isFolder/parentIndex 会拒绝。Editor 折叠节点后保存不改变层级/覆盖/XML，重载恢复默认展开。单元资源中已有的 `expanded`、`leaf` 控制器及其预置项属性覆盖仍保留；它们可能影响单元表现或特定 SDK 行为，不能等同于保存 Editor 树节点展开状态，也不能据此承诺游戏默认展开行为。

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

每项可编辑 `url`、`name`、`title`、`icon`、`selectedTitle`、`selectedIcon`、`properties`，0.18.0 另支持 `level`。文本和图标字段均为字符串：省略保留，空字符串清空，不接受 `null`。`url=""` 则恢复继承默认资源。

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

读取结果包含 `index`、原生当前 `url`、`effectiveUrl`、名称/标题/图标、`level` 与覆盖数组。空 url 表示继承；Editor 重载可能将源 XML 省略的 url 规范化为默认资源 URL，应结合有效资源及真实保存 XML 判断。`index/effectiveUrl` 和顶层 tree.nodes 是只读信息，level 在0.18.0可写；不要将整个读取结果直接当写入清单。修改项用 sourceIndex 保留原项。

## 校验与保存边界

先在临时原生 ListItemData 副本中检查全部字段、资源、索引及重复覆盖，再统一设置 `FList.defaultItem/items`；错误参数不会先修改原项或默认资源。通过 `FList.items` 原生 setter 重建 Editor 子项，应用后回读核对完整清单。

高级设置和 level 同样支持既有 CLI/批量 JSON，无需新命令。插件声明 list_settings_advanced 和 list_item_levels；Python 对包含新增字段的直接与批量写入在入队前校验，旧插件明确要求升级。只使用旧字段时保留原能力要求；旧插件读取可能没有 tree 元数据，先核对 capability。

clearOnPublish 只清空发布包中的示例项，源树预置项及层级保持；关闭后重新发布恢复示例数据。预置项的属性/控制器覆盖会按原生顺序应用，可能覆盖 title 等外层表现，以回读和实际单元资源为准。保存重载、发布、Editor视觉与 Unity/设备点击联调是不同证据。

默认不保存。`save=true` 保存整个当前组件，并按 Editor 原生序列化结果核对磁盘 XML。沿用现有布局接口的撤销边界：没有完整 Agent 事务撤销，Editor 拒绝或保存失败不自动回滚，响应会报告可能已发生的修改。发布期间拒绝写入。批量操作失败可能部分执行，超时先查批量回执。
