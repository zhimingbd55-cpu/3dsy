param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
$secure = (Get-Content -LiteralPath $Path -Raw).Trim() | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
