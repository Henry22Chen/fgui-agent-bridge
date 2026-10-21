# 进度条、滑块与下拉框

需要 Bridge 和插件 **0.19.0**，协议 `2.0`。六个 MCP 工具对应同名 Bridge Action 和 CLI 命令。全部省略 object_id/path/name 时编辑当前根定义；显式目标只允许当前父文档的直属组件实例。嵌套实例需先打开所属文档，不能穿透到共享定义。

## 接口与持久化作用域

| 接口 | 当前定义可写 | 直属实例可写 |
|---|---|---|
| fgui_get/set_progress_settings | titleType、reverse | min、max、value、sound、volume |
| fgui_get/set_slider_settings | titleType、reverse、wholeNumbers、changeOnClick | min、max、value |
| fgui_get/set_combo_settings | dropdown | items、title、icon、visibleItemCount、direction、selectionController、sound、volume、clearOnPublish |

getter 返回 `settings`、`scope`、`writableFields`、`sharedImpact`、`readOnlySettings` 和 `preview`。实例的 readOnlySettings 来自共享定义，修改它们必须显式打开定义，影响所有引用。定义内的 preview.instanceValues 是原生设计态值，instanceValuesPersisted=false；不能用它们宣称定义保存了范围或选项。

settings 使用补丁，省略保持。默认不保存；save=true 保存整个当前组件，并比对完整原生 XML 和磁盘。没有完整 Agent 事务撤销；原生拒绝或保存失败报告实际修改，不自动回滚。无变化且不保存时保留历史。发布期间这六个 Action 均拒绝执行。

## 进度条和滑块

- titleType 使用 Editor 字符串：percent、valueAndmax、value、max。reverse 为布尔值。
- ProgressBar 的 min/max/value 是原生 Int32，必须为整数；Slider 内存虽为 Single，但 Editor 6.1.4 将小数写入 XML 后不能正确重载，会退回默认范围，因此本版同样仅支持整数配置。两者范围 -1000000..1000000；最终必须满足 min < max 且 min <= value <= max。可同一补丁整体移动范围，先验证全部最终值，再按 min/max/value 稳定顺序写入，最后刷新原生显示。边界相等或单改 max 导致旧 value 越界时拒绝，不静默钳制。
- Slider 的 wholeNumbers/changeOnClick 为共享定义布尔配置。wholeNumbers 决定运行时拖动的取整行为；受当前原生重载限制，本接口无论开关均只写整数范围和值。修改共享整数模式不扫描和重写其他文档已有范围，应按需检查实例。
- ProgressBar 的 sound 是工程内声音 ui:// URL，空串清除引用；volume 为 **Editor 整数百分数 0..100**，0 明确有效。这两项保存在实例，不存在本版已验证的定义默认音效字段。

```bash
fgui-agent set-progress-settings '{"titleType":"valueAndmax","reverse":true}' --save
fgui-agent set-progress-settings --id progress1 '{"min":200,"max":400,"value":350,"sound":"","volume":0}' --save
fgui-agent set-slider-settings '{"wholeNumbers":true,"changeOnClick":false}' --save
fgui-agent set-slider-settings --id slider1 '{"min":0,"max":10,"value":4}' --save
```

第一和第三条须分别在 ProgressBar / Slider 定义文档执行；实例范围不会借此写入共享定义。

## 下拉框选项、引用和默认显示

items 是**完整最终有序清单**，每项为 `{title,value,icon?}`。title/value 必须是字符串，允许空串；icon 省略等同空串，非空必须是包内图片 URL。最多10000项；清单中新增为添加、遗漏为删除、顺序即重排，items=[] 清空。本接口不使用 sourceIndex，也不保留未列出的旧选项。原生列序经验证为 title/value/icon，调用方无需构造字符串列数组。

- dropdown 仅在当前定义可写，必须是含唯一名为 list 的直属原生 List 的组件 URL；空串移除引用。接口不补建列表或单元，也不修改被引用资源。
- visibleItemCount 是1..10000整数；direction 为 auto/up/down；两者属于实例。
- title/icon 保存实例默认显示，字符串空串清除。原生重载可能把 null/空值规范化为配置空串；工具统一回读空串。默认显示不代表保存了唯一选中索引或业务 value，重复标题/值允许；本版拒绝 selectedIndex 字段，调用方不能据此承诺游戏默认选项身份。
- selectionController 绑定**父文档**控制器名称，空串解除。绑定时其当前 selectedIndex 必须对应最终清单；工具按该索引刷新标题/图标，重排后也重新推导。此时 writableFields 排除 title/icon，显式写它们会拒绝；先或同一补丁解除绑定即可自定义显示。绑定时清空清单需同一补丁解除绑定，接口不改变控制器页面或当前选中页。
- sound/volume 使用声音 URL及0..100整数百分数，空串/0有效。clearOnPublish 为布尔值，只清空导出包的示例选项，源 items 保留；关闭后重新发布恢复选项。

```json
{
  "items": [
    {"title":"选项 B","value":"b","icon":"ui://PACKAGEIMAGE"},
    {"title":"选项 A","value":"a"}
  ],
  "selectionController":"",
  "title":"请选择",
  "icon":"",
  "visibleItemCount":5,
  "direction":"auto"
}
```

通用 text/icon 接口保持原有能力；有控制器绑定时仍会受原生联动影响，优先读取专用接口的可写范围和实际值。

## 批量、能力协商与验证边界

set_progress_settings、set_slider_settings、set_combo_settings 可用于单文档批量，**仅支持显式直属实例 target**。当前根定义不进入实例批量；分别显式打开对应定义后编辑，不隐式跨文档改共享资源。整批 save，禁止单步 save；执行失败可能保留已完成前缀，先查回执。

六个 Action 各有同名 capability，Python 在直接和批量入队前检查；旧插件明确要求升级0.19.0。未知字段和非法类型由原生写前预检，MCP settings 字典不把字符串/布尔值自动转换成数值。

设置保存、重载、Editor 填充方向/标题截图和发布分别验收。真实游戏的拖动、点击改变值、弹出方向、声音播放及网络数值绑定不属于本版运行验证；不自动修复缺失的 bar/grip/dropdown 子对象。
