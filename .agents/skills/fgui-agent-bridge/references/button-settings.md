# 按钮设置与六态资源

需要 Bridge、插件 **0.15.0** 或更高版本。新增四个 MCP 工具及同名 CLI 命令。默认不保存；`save=true` 保存整个当前组件并核对原生 XML，无完整事务回滚。

## 按钮设置作用域

`fgui_get_button_settings` 返回 `scope`、`writableFields`、`settings`、实例覆盖标记 `overrides`、只读定义值 `readOnlySettings` 和预览选中状态。`fgui_set_button_settings(settings)` 的目标可用 object_id/path/name；全部省略时编辑当前按钮定义，指定实例时仅编辑父文档直属 Button。

| 字段 | 定义 | 实例覆盖 | 合约 |
|---|---|---|---|
| mode | 可写 | 只读 | common/check/radio；改变共享定义的运行时选择行为，不重写父控制器绑定 |
| title / selectedTitle | 编辑定义内部文本；selectedTitle 不属于定义持久化 | 可写 | 字符串，空串清除；只保存当前实例 |
| icon / selectedIcon | 编辑定义内部 Loader；selectedIcon 不属于定义持久化 | 可写 | 包内图片 ui:// URL，空串清除 |
| titleColor | 可写 | 可写，自动启用覆盖 | RGB 或不透明 RGBA；没有标题文本时拒绝 |
| titleFontSize | 可写 | 可写，自动启用覆盖 | 1..1000 整数；没有标题文本时拒绝 |
| sound | 定义默认音效 | 可写，自动启用覆盖 | 包内声音 ui:// URL；定义空串移除显式音效、回到项目默认；实例空串为显式静音 |
| volume | 定义默认音量 | 可写，自动启用覆盖 | **Editor 百分数 0..100**，0 有效 |
| downEffect | 可写 | 只读 | none/tint/scale；scale 可能按 Editor 语义调整定义 Pivot |
| downEffectValue | 可写 | 只读 | 0..1，仅 tint/scale 有效；0 有效 |

`selected` 与父控制器/页面绑定继续使用 `fgui_get/set_button_binding`。不把预览选中状态写入定义。实例颜色、字号和音效必须有原生覆盖标记；工具自动维护，不开放仅改变内存的定义字段。音效和音量共用覆盖标记，首次覆盖会保留另一项的有效定义值。此版本不提供恢复继承/删除覆盖的接口。

title/icon 等内容字段读取实例配置值，未设置时可能为空串，不展开定义内部默认文本。`preview.displayedTitle` 单独报告当前实际显示的标题；选中标题/图标清空后按原生规则回到普通态内容，不能把配置空串等同于当前预览一定无文字。

## 六态图片映射

`fgui_get_button_state_resources()` / `fgui_set_button_state_resources(settings, save=false)` 只作用于当前打开的按钮定义，不接受跨文档资源目标。

settings 是六个状态键的补丁：`up`、`down`、`over`、`selectedOver`、`disabled`、`selectedDisabled`。值必须是包内图片 URL 或明确空串；省略保持。Getter 返回每态的稳定 pageId、targetId、mapping、writable 和不可编辑原因。

只识别唯一原生 `button` 控制器的语义页面和以下结构，不依靠子对象名称：

- 直属 Image/Loader 通过一个 Display Gear 唯一绑定一个状态页。
- 无显隐 Gear 的直属 Loader 通过 Icon Gear 提供页面资源。默认值和未修改页面保持；原生省略的默认值从 Loader 序列化的基础 url 读取。

多个候选、共享显隐载体、多重 Gear 条件等复杂结构返回 `unsupported_mapping` 和候选/原因。缺失页或缺失载体会返回 writable=false，不自动创建页面或猜测布局。Editor 6.1.4 原生模板可能只生成四个页面，即使创建参数包含六态图片；以实际读取的映射为准。

清空只清当前状态载体内容，保留页面与原有原生状态回退规则；它不表示自动改成 up 图。Image 无法原生保存空资源，因此普通 Image 首次清空时经 `Document.ReplaceSelection("loader")` 转为空 Loader，返回 conversions，并核对 ID、布局、Gear、Relation 不变。新 Loader 使用 scaleFree 保持原 Image 按对象尺寸拉伸的行为，之后替换直接设置 URL。带额外染色/翻转/填充的 Image 清空时拒绝，避免转换丢失显示语义。Editor 设计态可能显示空 Loader 占位标记，它不是发布后的图片内容。

## CLI 和批量

```bash
fgui-agent get-button-settings
fgui-agent set-button-settings '{"mode":"check","volume":0,"downEffect":"tint","downEffectValue":0.8}' --save
fgui-agent set-button-settings --id button1 '{"title":"普通","selectedTitle":"已选","sound":"","volume":0}' --save
fgui-agent get-button-state-resources
fgui-agent set-button-state-resources '{"up":"ui://PACKAGEIMAGE","down":""}' --save
```

仅 `set_button_settings` 的**实例写入**可批量，必须显式直属 target。定义和状态图编辑不进入实例批量；不切换文档、不偷偷改共享源。仍需 document_url、expected_revision、operation_key；整批 save，禁止单步 save。旧插件在入队前拒绝四个新 Action，包括批量内部调用。

## 验证边界

设置、保存核对、重载、六态设计截图和游戏实际点击/播放声音分别验证。音效资源引用与音量可持久化，不代表真实设备音频播放已验证；不变更游戏运行时点击逻辑。
