<#
  Builds the Bluetooth helpers in src/ble from their .cs files with the C# compiler of the .NET Framework 4 that is on every
  Windows 10/11 PC, against the Windows SDK's union Windows.winmd (build PC only; the built exes need only .NET Framework 4.5+
  and Windows 10 1703+, both standard):
    govee-ble-helper.exe   Govee lights (Studio 0.2.11)
    heart-ble-helper.exe   heart-rate sensors and watches (Studio 0.2.14)
  Run it before `npm run build` when a .cs changed:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-ble-helper.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
$union = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\UnionMetadata\10.*\Windows.winmd" | Sort-Object FullName | Select-Object -Last 1
if (-not $union) { throw 'Windows SDK UnionMetadata\Windows.winmd not found (install the Windows 10/11 SDK)' }
$refs = @($union.FullName, 'System.Runtime.WindowsRuntime.dll', 'System.Runtime.dll', 'System.Runtime.InteropServices.WindowsRuntime.dll', 'System.Threading.Tasks.dll', 'System.Web.Extensions.dll') |
    ForEach-Object { if ([IO.Path]::IsPathRooted($_)) { "-r:$_" } else { "-r:$(Join-Path $fw $_)" } }
foreach ($name in @('govee-ble-helper', 'heart-ble-helper')) {
    & $csc -nologo -optimize -platform:anycpu "-out:$(Join-Path $root "src\ble\$name.exe")" @refs (Join-Path $root "src\ble\$name.cs")
    if ($LASTEXITCODE -ne 0) { throw "csc failed for $name ($LASTEXITCODE)" }
    Write-Output "built src\ble\$name.exe"
}
