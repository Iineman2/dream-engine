# Serves Dream Engine from this PC and opens it on an Android phone over USB.
# Nothing is published: `adb reverse` maps the phone's localhost:8787 to this PC,
# and localhost counts as a secure context, so the mic, wake lock and install work.
# After "Add to Home screen > Install" the app runs offline; you can unplug.
# Keep the same port every time: the phone stores your data per origin.
param([int]$Port = 8787)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$adb = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $adb) {
  $adb = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Google.PlatformTools*\platform-tools\adb.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $adb) { Write-Error 'adb not found. Install Android platform-tools.'; exit 1 }

$attached = & $adb devices | Select-String -Pattern "`tdevice$"
if (-not $attached) {
  Write-Host 'No phone found. On the phone: Settings > About phone > tap Build number 7x, then Developer options > USB debugging on. Connect by USB, accept the prompt, and run this again.'
  exit 1
}

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  $server = Start-Process node -ArgumentList "`"$here\serve.mjs`" $Port" -PassThru -WindowStyle Minimized
  Start-Sleep -Milliseconds 800
  Write-Host "Server started (PID $($server.Id)). Stop it later with: Stop-Process -Id $($server.Id)"
} else {
  Write-Host "Server already listening on $Port."
}

& $adb reverse "tcp:$Port" "tcp:$Port" | Out-Null
& $adb shell am start -a android.intent.action.VIEW -d "http://localhost:$Port/" com.android.chrome | Out-Null
Write-Host "Opened http://localhost:$Port on the phone in Chrome. Then: menu > Add to Home screen > Install."
