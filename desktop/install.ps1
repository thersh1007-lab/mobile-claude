# Mobile Claude Desktop — Install script
# Creates: Desktop shortcut, Start Menu shortcut, Task Scheduler auto-start
# Run: powershell -ExecutionPolicy Bypass -File install.ps1

$AppName = "Mobile Claude"
$DesktopDir = Join-Path $PSScriptRoot ".."
$ElectronExe = Join-Path $PSScriptRoot "node_modules\.bin\electron.cmd"
$AppDir = $PSScriptRoot

Write-Host ""
Write-Host "  Installing $AppName..." -ForegroundColor Cyan
Write-Host ""

# 1. Desktop shortcut
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopPath "$AppName.lnk"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = (Get-Command node).Source
$Shortcut.Arguments = "`"$ElectronExe`" `"$AppDir`""
$Shortcut.WorkingDirectory = $AppDir
$Shortcut.Description = "Mobile Claude - AI Terminal"
$Shortcut.Save()
Write-Host "  Desktop shortcut: OK" -ForegroundColor Green

# 2. Start Menu shortcut
$StartMenuPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$StartShortcut = Join-Path $StartMenuPath "$AppName.lnk"
$Shortcut2 = $WshShell.CreateShortcut($StartShortcut)
$Shortcut2.TargetPath = (Get-Command node).Source
$Shortcut2.Arguments = "`"$ElectronExe`" `"$AppDir`""
$Shortcut2.WorkingDirectory = $AppDir
$Shortcut2.Description = "Mobile Claude - AI Terminal"
$Shortcut2.Save()
Write-Host "  Start Menu shortcut: OK" -ForegroundColor Green

# 3. Task Scheduler — auto-start on login (hidden)
$TaskName = "MobileClaude"

# Remove old task if exists
schtasks /delete /tn $TaskName /f 2>$null

$NodePath = (Get-Command node).Source
$TaskArgs = "`"$ElectronExe`" `"$AppDir`" --hidden"

schtasks /create /tn $TaskName /tr "`"$NodePath`" $TaskArgs" /sc onlogon /rl limited /f | Out-Null
Write-Host "  Auto-start (Task Scheduler): OK" -ForegroundColor Green

Write-Host ""
Write-Host "  Done! $AppName will:" -ForegroundColor Cyan
Write-Host "    - Auto-start on login (minimized to tray)"
Write-Host "    - Show in Start Menu and Desktop"
Write-Host "    - Toggle with Ctrl+Shift+C"
Write-Host ""
Write-Host "  To uninstall: schtasks /delete /tn $TaskName /f" -ForegroundColor DarkGray
Write-Host ""
