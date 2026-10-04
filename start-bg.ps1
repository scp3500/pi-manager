param(
  [string]$NodeCmd = "node",
  [string]$WorkDir = $PSScriptRoot,
  [string]$LogFile = $(Join-Path $PSScriptRoot "logs\server.log"),
  [string]$ErrFile = $(Join-Path $PSScriptRoot "logs\server.err.log"),
  [string]$PidFile = $(Join-Path $PSScriptRoot "logs\last-pid.txt")
)

$ErrorActionPreference = "Stop"
if (-not $env:PI_CONFIG_DIR) { $env:PI_CONFIG_DIR = 'E:\pi_agent\pi_config' }
New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

# Rotate huge logs lightly
foreach ($f in @($LogFile, $ErrFile)) {
  if ((Test-Path $f) -and ((Get-Item $f).Length -gt 2MB)) {
    Move-Item -Force $f ($f + ".1")
  }
}

$p = Start-Process -FilePath $NodeCmd `
  -ArgumentList "server.js" `
  -WorkingDirectory $WorkDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $LogFile `
  -RedirectStandardError $ErrFile `
  -PassThru

$p.Id | Set-Content -Path $PidFile -Encoding ascii
Write-Output $p.Id
