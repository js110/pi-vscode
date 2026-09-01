$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$codeCommand = Get-Command code.cmd -ErrorAction Stop
$testRoot = Join-Path $projectRoot '.vscode-test-local'
$userDataDir = Join-Path $testRoot 'user-data'
$extensionsDir = Join-Path $testRoot 'extensions'
$extensionTestsPath = Join-Path $projectRoot 'out-test\test\integration\suite\index.js'

New-Item -ItemType Directory -Force -Path $userDataDir, $extensionsDir | Out-Null

& $codeCommand.Source `
    --wait `
    --disable-extensions `
    --disable-workspace-trust `
    --skip-welcome `
    --user-data-dir=$userDataDir `
    --extensions-dir=$extensionsDir `
    --extensionDevelopmentPath=$projectRoot `
    --extensionTestsPath=$extensionTestsPath `
    $projectRoot

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
