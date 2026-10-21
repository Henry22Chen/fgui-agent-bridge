# 外观编辑回归夹具

此目录为可复用测试源，不包含业务 UI 或验证截图。`Pattern.png` 是确定性的四色测试图，左上白色标记用于分辨翻转方向。

将整个目录复制到仓库外的独占测试目录，再用 `scripts/sync_to_project.py --project PATH/Capabilities.fairy --apply` 安装当前插件。脚本拒绝对仓库内夹具或其他工程 ID 执行写入。

```powershell
python tests/live_visual_validation.py --project /ABS/TEST/Capabilities.fairy --editor /ABS/FairyGUI-Editor.exe --report /ABS/OUT/visual-results.json
```

实际测试覆盖 Graph 全部开放类型、透明色/0 线宽/圆角、多边形与半径倍率、图片翻转及填充、颜色滤镜及清除、重载、批量和原生 XML 发布。截图与报告保留在测试目录，并需实际观察，不能以截图生成成功代替视觉验收。发布输出固定为测试工程内 `published`，关闭代码生成。
