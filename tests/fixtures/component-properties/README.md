# 组件实例属性隔离夹具

固定工程 ID 为 `fgui-component-properties-regression-0001`。复制本目录到独立测试目录，安装当前插件并明确打开该副本；不要在业务工程执行写入测试。

包含两个引用相同 Child 资源的实例、导出与私有控制器、文本/图标及点分嵌套属性。用于验证实例覆盖不会修改共享定义或其他实例，以及根组件属性定义和控制器导出设置的保存、重开行为。

`tests/live_component_properties.py --project /ABS/Capabilities.fairy --editor /ABS/FairyGUI-Editor.exe --report /ABS/results.json` 执行真实 MCP 写入验证。关闭并重开同一测试工程后追加 `--read-only`，验证持久化；脚本不会自动启动 Editor。
