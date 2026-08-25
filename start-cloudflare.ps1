param(
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

# The Preview URL: a Cloudflare quick tunnel to the Measurement Server. cloudflared prints the
# https://<four-words>.trycloudflare.com address it was given; it changes every session. Warm it with
# one request before a Run — the first request through a fresh tunnel is a cold start.

$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
    throw "cloudflared is not available in this PowerShell session. Install it (winget install Cloudflare.cloudflared), open a new terminal, and run this script again."
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python is required to serve this static page."
}

$server = Start-Process python -ArgumentList "server.py", $Port -WorkingDirectory $PSScriptRoot -PassThru

try {
    Start-Sleep -Milliseconds 500
    & $cloudflared.Source tunnel --url "http://localhost:$Port"
}
finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force
    }
}
