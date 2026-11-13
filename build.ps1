# 编译 1Panel 桌面外壳（WinForms + WebView2）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$cscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
  throw '未找到 .NET Framework 的 csc.exe，请先启用 .NET Framework 4.x。'
}

$required = @(
  'Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.WinForms.dll',
  'WebView2Loader.dll',
  'desktop\Program.cs',
  'app\server.js',
  'runtime\node.exe'
)
foreach ($f in $required) {
  if (-not (Test-Path (Join-Path $root $f))) { throw "缺少文件：$f" }
}

& $csc -nologo -target:winexe -platform:x64 -optimize+ -codepage:65001 `
  -r:System.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll `
  -r:Microsoft.Web.WebView2.Core.dll -r:Microsoft.Web.WebView2.WinForms.dll `
  -out:"$root\1Panel-Installer.exe" "$root\desktop\Program.cs"

if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }
Write-Host "已生成：$root\1Panel-Installer.exe"