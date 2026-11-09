param([string]$Python = "python")
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$localPython = Join-Path $projectRoot "local-translation\venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $localPython)) {
    & $Python -m venv (Join-Path $projectRoot "local-translation\venv")
    if ($LASTEXITCODE -ne 0) { throw "Creating Python environment failed. Use Python 3.12 x64." }
}
& $localPython -m pip install --timeout 60 libretranslate==1.9.6 "chardet<6"
if ($LASTEXITCODE -ne 0) { throw "Installing LibreTranslate failed." }
& $localPython -X utf8 (Join-Path $PSScriptRoot "local_translate.py") --install
if ($LASTEXITCODE -ne 0) { throw "Installing translation model failed." }
