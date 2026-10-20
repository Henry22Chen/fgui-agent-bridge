# 组件实例与自定义属性能力验收

日期：2026-10-20。基线 `v0.10.0` / `170ac71`，分支 `feat/component-instance-properties`，实现版本 `0.11.0`，协议仍为 `2.0`，MCP 工具数从 80 增至 87。本报告记录功能验收，发布与业务工程部署状态需另行核对。

## 实现

- `get_component_instance` 读取直属组件实例的控制器、导出/备注、实例覆盖页，以及文本/图标覆盖值和实际值。
- `set_component_instance_controller` 更新原生 ComProperty(-1) 并应用控制器页面，避免只改预览选中页、不写入实例 XML 的情况。仅操作已导出的控制器。
- `set_component_instance_property` 更新已暴露的文本(0)/图标(1)，支持点分内部路径和空字符串；只改父文档覆盖值，不改共享资源或其他实例。
- `get_component_properties` / `upsert_component_property` / `remove_component_property` 维护当前根组件的属性映射，保留元件及默认值；省略 label 保留备注。
- `set_controller_properties` 设置当前根控制器的 exported/alias，保留页面、选择和联动；现有 get_controllers 同时返回这些元数据。
- 五个写操作接入批量，实例 target 可引用插入时的 ref；新能力对旧插件在入队前明确拒绝。CLI 与 MCP 参数和工具文档同步。
- 默认不保存；save=true 比对父/根组件完整 Write_editMode 原生快照与磁盘 XML。修改清除旧 Agent 属性历史，无完整事务撤销，失败保持实际状态及 dirty，不伪称回滚。

## 真实原生语义确认

独立夹具中的探测证明：实例 customProperties 已含导出控制器和属性声明；必须修改该实例现有 ComProperty.value 并 ApplyCustomProperty，才能同时改变显示和实例 XML。单独设置 selectedPageId 不会产生实例 controller 覆盖。

根组件的 Write 返回实例引用；定义保存必须使用 Write_editMode。测试已验证 exported/alias、customProperty 定义与实例 controller/property 覆盖均能在关闭重开后保留。

ApplyCustomProperty(null) 会移除 XML 覆盖，但当前显示值并不恢复。为避免误报恢复继承，实例 setter 当前仅接收明确字符串（包含空串），不支持 null 清除覆盖；这不是 customData 原始数据入口。

## 验证

- TypeScript 5.4.5 编译通过，main.js 与 main.ts 一同保留。
- uv.lock 仅更新项目版本，依赖没有升级；Python compileall 通过。
- 86 项自动回归通过，其中新增 5 项接口回归；其中的编译宿主测试覆盖 13 个案例，包括源资源/兄弟实例隔离、空字符串、未导出属性拒绝、路径歧义、导出开关、标签保留、联动重定向及保存失败状态。
- 23 项真实 Windows Editor/MCP 用例通过，覆盖控制器和文本/图标/嵌套属性、父组件 XML、七项非法请求拒绝且 revision 不变、根定义增改删、控制器导出/取消及备注、批量原生 ID/ref 和部分失败回执。
- 9 项关闭重开只读检查通过，确认实例控制器、文本/图标/空串、兄弟实例继承、批量创建实例、根控制器导出/备注、定义标签持久化，文档保持干净。
- 真实联调使用固定专用工程标识 `fgui-component-properties-regression-0001`；测试脚本不自动启动 Editor，不接受业务工程。测试始终只保留一个本任务专用 Editor，原业务实例未改动。

便携验证数据：`tests/reports/component-properties-0.11.0.json`。未在业务 UI 执行编辑、保存、发布，也未进行 Unity 编译、游戏运行或美术视觉验收。

## 边界

- 实例目标限当前文档直属组件；内部属性路径允许点分嵌套，逐层检查名称唯一。不通过深层 FObject 定位绕过组件实例覆盖机制。
- 控制器实例覆盖要求先在源组件导出；文本/图标实例覆盖要求已定义对应映射。定义只支持 Editor 原生公开的文本和图标。
- 移除定义不扫描或清理其他文档的旧覆盖；其他已打开文档的元数据刷新遵循 Editor 原生行为，不覆盖未保存修改。
- 新接口及批量不是原子事务；超时先查回执。实例控制器的 Gear/联动可能改变结果，重定向时报告实际状态。

## 影响文件（相对 Bridge 仓库）

| 文件与位置 | 作用 |
|---|---|
| `plugin/main.ts:708` | 实例、定义、原生值与路径验证、完整持久化回读 |
| `plugin/main.ts:1253` | 新能力声明 |
| `plugin/main.ts:4139` | 五个新批量操作及作用域 |
| `plugin/main.js:1` | 编译后的实际运行文件 |
| `plugin/package.json:5`、`pyproject.toml:7`、`src/fairygui_agent/__init__.py:3`、`uv.lock:1` | 0.11.0 版本同步 |
| `src/fairygui_agent/mcp_server.py:603` | 七个新 MCP 工具 |
| `src/fairygui_agent/bridge_client.py:75` | 新能力协商，含批量内部动作 |
| `src/fairygui_agent/performance.py:26` | 批量参数白名单 |
| `src/fairygui_agent/cli.py:354` | 七个 CLI 子命令及参数转发 |
| `.agents/skills/fgui-agent-bridge/SKILL.md:72` | 实例/定义工作流及安全边界 |
| `.agents/skills/fgui-agent-bridge/references/current-capabilities.md:7` | 87 工具及参数/限制 |
| `.agents/skills/fgui-agent-bridge/references/editing-plans.md:34` | 新批量动作 |
| `.agents/skills/fgui-agent-bridge/references/component-properties.md:1` | 详细调用说明及边界 |
| `README.md:5` | 版本状态、工具分类及能力说明 |
| `tests/test_component_properties.py:1`、`tests/component_properties_host_harness.cjs:1` | 参数、旧插件拒绝、CLI 及编译宿主回归 |
| `tests/test_animation_surfaces.py:144` | 87 工具契约 |
| `tests/live_component_properties.py:1` | 真实 Editor 写入/重开脚本 |
| `tests/fixtures/component-properties/README.md:1`、`Capabilities.fairy:1` | 隔离夹具用法及身份（同目录） |
| `tests/fixtures/component-properties/assets/Probe/package.xml:1`、`Root.xml:1`、`Child.xml:1`、`Inner.xml:1` | 资源目录与三个组件（同目录） |
| `tests/fixtures/component-properties/assets/Probe/Panel.png` | 合成测试图片，复制已有夹具，二进制文件 |
| `tests/reports/component-properties-0.11.0.md:1`、`tests/reports/component-properties-0.11.0.json:1` | 本报告与便携验证数据 |
