// 仅由 live_gear_preview.py 安装到仓库外专用工程；不能加入正式 plugin/main.js。
function gearPreviewProbe(params) {
    if (String(App.project.id) !== "fgui-gear-lifecycle-regression-0001") throw new Error("仅允许 Gear 专用测试工程");
    if (!params || Object.keys(params).some(k => !["operation", "pageId"].includes(k))) throw new Error("未知测试参数");
    if (params.operation === "stop") { App.testView.Stop(); return { stopped: true }; }
    if (!["start", "select", "read"].includes(params.operation)) throw new Error("未知测试操作");
    if (params.operation === "start") App.testView.Start();
    if (!App.testView.running) throw new Error("原生运行预览尚未启动");
    // TestView 的只读私有引用仅用于 6.1.4 隔离验收，不能把设计文档对象误作运行副本。
    const content = App.testView.GetType().GetField("_content", 36).GetValue(App.testView);
    if (!content || String(content.resourceURL) !== "ui://geartestroot") throw new Error("预览副本资源不符");
    const c = resolveController({ content }, "State"), child = content.GetChild("label"), movie = content.GetChild("movie");
    if (params.operation === "select") c.selectedPageId = params.pageId;
    const gear = child.GetGear(1, false);
    return { timestamp: Date.now(), running: true, pageId: String(c.selectedPageId), x: Number(child.x), y: Number(child.y),
        tween: Boolean(gear && gear.tween), duration: gear ? Number(gear.duration) : null, delay: gear ? Number(gear.delay) : null,
        ease: gear ? String(gear.easeName) : null, tweenActive: Boolean(gear && gear.GetType().GetField("_tweener", 36).GetValue(gear)),
        movie: movie ? { frame: Number(movie.frame), playing: Boolean(movie.playing), renderFrame: Number(movie.displayObject.content.frame) } : null };
}
