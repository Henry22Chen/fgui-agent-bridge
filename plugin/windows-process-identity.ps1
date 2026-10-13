# IL2CPP 可读取自身 PID，但不支持 Process.StartTime；仅在插件初始化时查询指定 PID。
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$EditorProcessId,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$editorProcess = [System.Diagnostics.Process]::GetProcessById($EditorProcessId)
try {
    $identityJson = @{
        pid = $editorProcess.Id
        startedAt = $editorProcess.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssfffffff', [System.Globalization.CultureInfo]::InvariantCulture)
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($OutputPath, $identityJson, [System.Text.UTF8Encoding]::new($false))
}
finally {
    $editorProcess.Dispose()
}
