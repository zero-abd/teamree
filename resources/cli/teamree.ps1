# The `teamree` CLI as PowerShell resolves it. PowerShell looks for .ps1 on
# PATH, cmd.exe looks for .cmd, so the pair covers both shells; both hand the
# bundled CLI to the app's Electron binary running in plain-Node mode.
$ErrorActionPreference = 'Stop'
$env:ELECTRON_RUN_AS_NODE = '1'
& "$PSScriptRoot\..\..\teamree.exe" "$PSScriptRoot\teamree.mjs" @args
exit $LASTEXITCODE
