@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $root = [IO.Path]::GetFullPath('%~dp0'); $serverPath = Join-Path $root 'direct_server.mjs'; $launcherPath = Join-Path $root 'launcher.py'; $serverArgument = '(?i)(?:^|\s|\x22)' + [regex]::Escape($serverPath) + '(?:\x22|\s|$)'; $launcherArgument = '(?i)(?:^|\s|\x22)' + [regex]::Escape($launcherPath) + '(?:\x22|\s|$)'; $servers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' -and $_.CommandLine -match $serverArgument }); if ($servers.Count -eq 0) { Write-Output 'No BitSeekWin server is running from this folder.'; exit 0 }; $stopIds = @(); foreach ($server in $servers) { $stopIds += $server.ProcessId; $parent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $server.ParentProcessId); if ($parent -and $parent.Name -ieq 'pythonw.exe' -and $parent.CommandLine -match $launcherArgument) { $stopIds += $parent.ProcessId } }; foreach ($id in ($stopIds | Select-Object -Unique)) { Stop-Process -Id $id -Force -ErrorAction Stop }; Start-Sleep -Seconds 1; $remaining = @($stopIds | Select-Object -Unique | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }); if ($remaining.Count -gt 0) { Write-Output ('Some BitSeekWin processes are still running: ' + (($remaining | ForEach-Object { $_.Id }) -join ', ')); exit 1 }; Write-Output ('Stopped BitSeekWin process(es): ' + (($stopIds | Select-Object -Unique) -join ', '))"
if errorlevel 1 (
    echo Failed to stop all matching BitSeekWin processes.
    exit /b 1
)
pause
