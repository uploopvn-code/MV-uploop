$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = (Get-Command node -ErrorAction Stop).Source
try { $null = Invoke-RestMethod 'http://127.0.0.1:7788/api/state' -TimeoutSec 2 }
catch { Start-Process -FilePath $nodePath -ArgumentList 'server.mjs' -WorkingDirectory $appRoot -WindowStyle Hidden; Start-Sleep -Seconds 2 }
Start-Process 'http://127.0.0.1:7788'
