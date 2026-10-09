param(
    [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
    [string[]] $ContainerCommand
)

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RawData = (Resolve-Path (Join-Path $PSScriptRoot 'data/raw')).Path

docker run --rm --network none `
    -v "${ProjectRoot}:/work" `
    -v "${RawData}:/work/ml/data/raw:ro" `
    -w /work `
    glasshouse-ml @ContainerCommand

exit $LASTEXITCODE
