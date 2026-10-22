# 控制器、页面与联动生命周期（0.20.0）

先 `fgui_get_controllers`，再 `fgui_get_controller_references(controller_name, page_id?)`。扫描项目全部包组件，打开文档采用原生内存快照，未打开文档读取源 XML；读取是只读操作。结果含 `references`、`scannedDocuments`、`complete`、`unknown`、文件路径、documentUrl、是否本地及是否未保存。覆盖 Gear、Button、List/Combo 选择绑定、Scroll 分页绑定、Action 条件/目标、specific 首页、实例及列表预置项的控制器覆盖。

包未打开、组件读取失败、未知引用字段/联动类型、无效页面引用会产生 unknown；不能把不完整扫描当作无引用。导出控制器的外部实例依赖保守列出，即使某实例没有显式覆盖；未导出控制器仍扫描外部 Action 目标。嵌套定义内部引用由它的独立组件资源覆盖。当前不进行跨文档自动迁移。

## 写入与引用策略

所有操作只写当前根文档，默认 `save=false`，`save=true` 保存整个组件并比较完整原生 XML。实际变化清除旧 Agent undo，失败报告实际状态和 mutationMayHaveOccurred，不自动回滚。MCP 错误保留结构化 `code/message/details`，引用拒绝在 `details.impact` 中附扫描结果。

| 工具 | 合约 |
|---|---|
| `fgui_rename_controller(controller_name,name,reference_policy="reject",save=false)` | 默认拒绝存在引用；local 同步本地 Gear/按钮/选择/分页/Action 目标名称，不重建页面，也不改自己的 Action 条件或无关目标 |
| `fgui_remove_controller(controller_name,reference_policy="reject",save=false)` | 无引用时可删除空或有页控制器；自身 Action 随控制器删除；local 清理其本地引用 |
| `fgui_remove_controller_page(controller_name,page_id,reference_policy="reject",replacement_page_id?,save=false)` | 只删指定稳定 ID，其余页保留原生对象与 ID；最后一页拒绝；删除首页/当前页必须指定保留页作为 replacement_page_id |
| `fgui_reorder_controller_pages(controller_name,ordered_page_ids,save=false)` | 输入包含当前全部页面 ID 的无重复最终顺序；原生 SwapPage 后恢复原选中 ID，不执行 Action；specific 首页仍按 ID，default 首页随首项变化 |
| `fgui_reorder_controller_actions(controller_name,ordered_indices,save=false)` | 输入调用前全部联动索引的无重复最终顺序；保留未知类型和原生对象，不执行联动；完成后重读索引 |

`reference_policy="local"` 是明确的受限处理：控制器改名同步已验证本地引用；删除时移除**完整被引用 Gear/Action**并解绑 Button/List/Combo/Scroll。删除页面也采用完整 Gear/Action 清理，可能影响保留页面的状态配置，因此先审阅 impact；接口不会隐式裁剪高级 Gear、猜测替代绑定或提供 force。首页用 replacement_page_id 替代后明确转为 specific；branch/variable 规则本身保留。未知范围、外部实例/联动一律写前拒绝，列出受影响文档；不会部分修改外部或脏文档。

主要拒绝码：`controller_referenced`、`external_references`、`unknown_references`、`last_page`、`default_page`、`selected_page`、`invalid_order`、`invalid_home_page`。外部/未知拒绝优先于引用清理，不存在绕过开关。

## 首页与当前预览页

`fgui_set_controller_properties` 扩展 `homePageType`、`homePage`、`autoRadioGroupDepth`，仍支持 exported/alias。省略保持；autoRadioGroupDepth 是布尔值。

| homePageType | homePage |
|---|---|
| default | 原生第一项；显式设置此类型时清空 homePage |
| specific | 必须为当前控制器的稳定页面 ID |
| branch | 按包分支名匹配页面名称；显式设置此类型时清空 homePage |
| variable | 非空变量名，运行时按变量值匹配页面名称 |

设置首页不切当前预览页。`fgui_set_controller_page` 仍只触发原生切页及 Gear/Action，不改首页配置。Editor 设计态重开可恢复 selected，运行时首页由发布数据决定；不能用预览页冒充首页。重排会改变 default/跟随索引的语义，页面改名会影响 branch/variable/跟随名称的匹配，调用者应按实际规则检查。

## 有名联动跟随模式

`fgui_upsert_controller_action` 的 change_page 保持旧 `targetPageId` 兼容，新增 `targetMode`：

- `page_id`（省略时默认）：必须提供目标控制器稳定 targetPageId。
- `follow_index`：跟随源控制器当前索引，需先核对目标页数和映射；禁止同时提供 targetPageId。
- `follow_name`：跟随源当前页面名称，需先核对目标是否存在同名页；禁止同时提供 targetPageId。

读取返回 targetMode；跟随模式的 targetPageId 为 null，原始 XML 仅用于诊断。公共输入拒绝直接传特殊值；继续拒绝自引用和控制器图循环。Action 按最终顺序执行，多个 Action 指向同一目标时后执行者可改变最终结果。

## 批量与 CLI

五个新写操作及既有 add/rename page、upsert/remove Action 均可进入 apply_batch；只读引用预览不进入批量。参数使用 camelCase，单步禁止 save，批量沿用 revision/operationKey 及实际部分执行回执。旧插件遇新增 action、首页字段或 targetMode 在入队前拒绝，包括嵌套批量。

CLI：get-controller-references、rename-controller、remove-controller、remove-controller-page、reorder-controller-pages、reorder-controller-actions；控制器名为位置参数，顺序用 JSON 数组，引用策略用 --reference-policy，页面用 --page-id/--replacement-page-id，保存用 --save。首页继续通过 set-controller-properties 的 settings JSON 修改。

验证入口：`tests/test_controller_lifecycle.py`、`tests/controller_lifecycle_host_harness.cjs`、`tests/live_controller_lifecycle.py`。真实 Editor 回归只写 `tests/fixtures/controller-lifecycle` 的仓库外副本；临时工程、日志和发布产物放目标 FGUI 工程 `.agent/tmp/<任务名>/`，不入库。
