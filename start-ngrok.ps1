param(
    [string]$Domain,
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

$ngrokCommand = Get-Command ngrok -ErrorAction SilentlyContinue
$ngrokPath = if ($ngrokCommand -and (Test-Path $ngrokCommand.Source)) {
    $ngrokCommand.Source
} else {
    $package = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Filter "Ngrok.Ngrok*" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    $packageExecutable = if ($package) { Join-Path $package.FullName "ngrok.exe" }
    if ($packageExecutable -and (Test-Path $packageExecutable)) { $packageExecutable }
}

if (-not $ngrokPath) {
    throw "ngrok is not available in this PowerShell session. Open a new terminal and run this script again."
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python is required to serve this static page."
}

$server = Start-Process python -ArgumentList "server.py", $Port -WorkingDirectory $PSScriptRoot -PassThru

try {
    Start-Sleep -Milliseconds 500
    $arguments = @("http", $Port)
    if ($Domain) {
        $arguments += "--domain=$Domain"
    }

    try {
        & $ngrokPath @arguments
    } catch [System.Management.Automation.PSInvalidOperationException] {
        throw "Windows Defender blocked ngrok.exe. Open Windows Security > Virus & threat protection > Protection history, review the ngrok detection, and allow this official ngrok installation if you trust it. Then run this script again."
    }
}
finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force
    }
}