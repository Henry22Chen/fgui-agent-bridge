# 高级 Gear 隔离回归夹具

复制整个目录到目标 FGUI 工程 .agent/tmp/<任务名>/live，安装正式插件后运行 tests/live_gear_lifecycle.py。两张 Frame 图片来自已有按钮测试夹具，作为原生 MovieClip 的输入；生成的动画资源、发布包、截图和报告只保存在副本，不提交。

保存后可安装 tests/live_gear_preview.py 的测试专用钩子，重启本轮拥有且身份已核对的 Editor 后验证运行副本的缓动和动画播放。然后恢复正式 plugin/main.js，再重启专用实例并用 --read-only 验证磁盘恢复。禁止对业务工程安装测试钩子或写测试节点。
