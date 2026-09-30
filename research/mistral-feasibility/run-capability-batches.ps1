param([string]$Models = 'mistral-small-2603,mistral-medium-3-5')
$ErrorActionPreference = 'Stop'

# Read the explicitly supplied clipboard credential once, retain only in this
# process while both research batches run, then release the reference.
$mistralKey = Get-Clipboard -Raw
if ([string]::IsNullOrWhiteSpace($mistralKey)) {
    Write-Output 'CLIPBOARD_EMPTY'
    exit 1
}
$mistralKey = $mistralKey.Trim()
if ($mistralKey.Length -gt 4096 -or $mistralKey -match '\s') {
    $mistralKey = $null
    Write-Output 'CLIPBOARD_NOT_A_SINGLE_API_TOKEN'
    exit 1
}

$researchRunExit = 0
try {
    $baselineRunner = Join-Path $PSScriptRoot 'run.mjs'
    $groundedRunner = Join-Path $PSScriptRoot 'run-v2.mjs'
    if (-not (Test-Path -LiteralPath $groundedRunner)) {
        throw 'Grounded benchmark runner is not ready.'
    }

    Write-Output 'Starting unchanged-prompt reasoning comparison.'
    $mistralKey | & node $baselineRunner --live --key-stdin --models $Models --repeats 1 --profile baseline --reasoning-effort high --concurrency 2 --grading-only
    if ($LASTEXITCODE -ne 0) {
        throw 'The reasoning comparison stopped. Inspect its non-secret diagnostics before proceeding.'
    }

    Write-Output 'Starting revised-method comparison across three new tasks.'
    $mistralKey | & node $groundedRunner --live --key-stdin --models $Models --repeats 2 --profile grounded --fixtures heldout.json --reasoning-effort high --concurrency 2 --grading-only
    if ($LASTEXITCODE -ne 0) {
        throw 'The revised-method comparison stopped. Inspect its non-secret diagnostics.'
    }
} catch {
    # Only explicit local messages are emitted. Never print a credential or
    # arbitrary exception details that could contain request information.
    Write-Output 'CAPABILITY_BATCH_STOPPED; inspect benchmark results and status output.'
    $researchRunExit = 1
} finally {
    $mistralKey = $null
}
exit $researchRunExit
