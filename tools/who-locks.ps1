# who-locks.ps1 — 查某个文件被哪个进程占着（Windows）
#
# 症状：`npm run dist` 报 EBUSY / "Device or resource busy" / "正由另一进程使用"，
#       却看不到 DS侧栏.exe 在跑 —— 说明有别的进程（编辑器、网盘同步、索引器、
#       备份工具等）对该文件持有句柄且不允许删除。electron-packager --overwrite
#       必须先删掉旧输出目录，只要有一个文件删不掉，整个打包就中断。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\who-locks.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\who-locks.ps1 -Target "D:\some\file"
#
# 本文件刻意只用 ASCII：PowerShell 5.1 会把无 BOM 的 .ps1 按 ANSI(GBK) 解码，
# 脚本里写中文路径会被静默解坏，导致"文件明明在却报不存在"。
param([string]$Target)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not $Target) {
  # 默认目标：仓库 dist/ 下任意绿色包里的 app.asar（避开中文字面量）
  $distRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'
  if (Test-Path -LiteralPath $distRoot) {
    $Target = (Get-ChildItem -LiteralPath $distRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'resources\app.asar' } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1)
  }
}
if (-not $Target) { Write-Output "no -Target given and nothing found under dist/"; exit 1 }

Write-Output ("TARGET : " + $Target)
Write-Output ("EXISTS : " + (Test-Path -LiteralPath $Target))

# 独占打开成功 = 没被占用
try {
  $fs = [System.IO.File]::Open($Target, 'Open', 'ReadWrite', 'None')
  $fs.Close()
  Write-Output "OPEN-TEST : not locked (exclusive open succeeded)"
} catch {
  Write-Output ("OPEN-TEST : LOCKED -> " + $_.Exception.Message)
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RM {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nSvc, string[] svcs);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] arr, ref uint reasons);
}
"@

$handle = 0
$key = [Guid]::NewGuid().ToString()
if ([RM]::RmStartSession([ref]$handle, 0, $key) -ne 0) { Write-Output "RmStartSession failed"; exit 1 }
try {
  $r = [RM]::RmRegisterResources($handle, 1, @($Target), 0, $null, 0, $null)
  if ($r -ne 0) { Write-Output ("RmRegisterResources failed: " + $r) }
  $needed = 0; $count = 0; $reasons = 0
  $r = [RM]::RmGetList($handle, [ref]$needed, [ref]$count, $null, [ref]$reasons)
  if ($r -eq 234) {                                  # ERROR_MORE_DATA
    $arr = New-Object 'RM+RM_PROCESS_INFO[]' $needed
    $count = $needed
    $r = [RM]::RmGetList($handle, [ref]$needed, [ref]$count, $arr, [ref]$reasons)
    if ($r -eq 0) {
      Write-Output ("LOCKERS : " + $count)
      for ($i = 0; $i -lt $count; $i++) {
        $p = $arr[$i]
        $proc = Get-Process -Id $p.Process.dwProcessId -ErrorAction SilentlyContinue
        Write-Output ("  PID=" + $p.Process.dwProcessId + " APP=" + $p.strAppName + " SVC=" + $p.strServiceShortName)
        if ($proc) { Write-Output ("      Name=" + $proc.ProcessName + "  Path=" + $proc.Path) }
      }
    } else { Write-Output ("RmGetList(2) failed: " + $r) }
  } elseif ($r -eq 0) {
    Write-Output "LOCKERS : 0 (no holder reported)"
  } else {
    Write-Output ("RmGetList(1) failed: " + $r)
  }
} finally { [void][RM]::RmEndSession($handle) }
