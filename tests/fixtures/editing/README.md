# 原生编辑回归夹具

本目录仅用于 Bridge 工具自身验证，不包含业务界面。`Capabilities.fairy` 使用固定测试工程 ID，脚本会拒绝其它工程。

将本目录复制到单独测试目录，通过 `scripts/sync_to_project.py --project PATH --apply` 安装当前插件，再用 FairyGUI Editor 打开该工程。不要在正式工程执行写入测试。

在 Bridge 根目录执行：

```powershell
python tests/live_editing_validation.py --project /ABS/PATH/Capabilities.fairy --editor /ABS/PATH/FairyGUI-Editor.exe --report /ABS/PATH/editing-results.json
```

该脚本通过真实 MCP 创建节点、修改布局和图片元数据，显式保存隔离工程，并验证非法输入被拒绝且对象树未改变。若需重跑完整写入测试，先关闭测试 Editor 并重新复制夹具，避免与已创建的节点重名。

完成写入后重新打开同一已保存测试工程，追加 `--read-only` 执行九项重开验证。普通单元测试只运行宿主契约及输入边界检查，不自动启动 Editor。
