# Tests for the voice worker's refusal conditions (VoiceWorker.Rules.ps1, simulated inputs) and its per-job scratch
# encryption and owner-only folders (VoiceWorker.Crypto.ps1, real but in a temp folder). No GPU, OBS or server
# needed. Run: pwsh -NoProfile -File voice-worker.tests.ps1   (exit code = number of failures)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VoiceWorker.Rules.ps1')
. (Join-Path $PSScriptRoot 'VoiceWorker.Crypto.ps1')
$fail = 0
function Check([string]$name, [bool]$ok) { if ($ok) { "PASS  $name" } else { "FAIL  $name"; $script:fail++ } }
function Codes($s) { @(Test-VoiceBlockers $s | ForEach-Object { $_.Code }) }

$clear = @{ ScratchOk = $true; PacificHour = 10; GpuSecondsToday = 0; ObsRunning = $false; DenyRunning = @(); GpuUtil = 2; GpuUsedMb = 900; GpuFreeMb = 15000; GpuTempC = 40; OllamaModels = 0; Training = $false }
function With($o) { $h = $clear.Clone(); foreach ($k in $o.Keys) { $h[$k] = $o[$k] }; $h }

Check 'all clear: may train' ((Codes $clear).Count -eq 0)
Check 'scratch folders not owner-only: refuses' ((Codes (With @{ ScratchOk = $false })) -contains 'scratch')
Check 'scratch state unknown: refuses' ((Codes (With @{ ScratchOk = $null })) -contains 'scratch')
Check 'a scratch refusal is hard' (((Test-VoiceBlockers (With @{ ScratchOk = $false })) | Where-Object Code -eq 'scratch').Hard -eq $true)
Check '01:59 Pacific: outside the window' ((Codes (With @{ PacificHour = 1 })) -contains 'outside_window')
Check '02:00 Pacific: inside' (-not ((Codes (With @{ PacificHour = 2 })) -contains 'outside_window'))
Check '13:59 Pacific: inside' (-not ((Codes (With @{ PacificHour = 13 })) -contains 'outside_window'))
Check '14:00 Pacific: outside' ((Codes (With @{ PacificHour = 14 })) -contains 'outside_window')
Check '4 GPU-hours used: daily cap' ((Codes (With @{ GpuSecondsToday = 14400 })) -contains 'daily_cap')
Check '3h59 used: not capped' (-not ((Codes (With @{ GpuSecondsToday = 14399 })) -contains 'daily_cap'))
Check 'OBS open: owner may be live' ((Codes (With @{ ObsRunning = $true })) -contains 'owner_live')
Check 'OBS state unknown: treated as live' ((Codes (With @{ ObsRunning = $null })) -contains 'owner_live')
Check 'server says owner live' ((Codes (With @{ ServerPause = 'owner_live' })) -contains 'owner_live')
Check 'owner live waits 30 minutes' (((Test-VoiceBlockers (With @{ ObsRunning = $true })) | Where-Object Code -eq 'owner_live').ClearMinutes -eq 30)
Check 'a game is running' ((Codes (With @{ DenyRunning = @('FortniteClient-Win64-Shipping') })) -contains 'game')
Check 'Ollama has a model loaded' ((Codes (With @{ OllamaModels = 1 })) -contains 'ollama')
Check 'Ollama could not be asked: refuses' ((Codes (With @{ OllamaModels = $null })) -contains 'ollama')
Check 'GPU busy while idle (util)' ((Codes (With @{ GpuUtil = 40 })) -contains 'gpu_busy')
Check 'GPU busy while idle (memory)' ((Codes (With @{ GpuUsedMb = 6000 })) -contains 'gpu_busy')
Check 'own training uses the GPU: not busy' (-not ((Codes (With @{ Training = $true; GpuUtil = 99; GpuUsedMb = 9000; GpuFreeMb = 7000 })) -contains 'gpu_busy'))
Check 'another program takes the VRAM while training' ((Codes (With @{ Training = $true; GpuUtil = 99; GpuUsedMb = 15900; GpuFreeMb = 300 })) -contains 'gpu_busy')
Check 'nvidia-smi silent: refuses' ((Codes (With @{ GpuUtil = $null })) -contains 'gpu_unknown')
Check 'GPU at 83 C: soft stop' (((Test-VoiceBlockers (With @{ GpuTempC = 83 })) | Where-Object Code -eq 'hot').Hard -eq $false)
Check 'manual pause' ((Codes (With @{ ManualPause = $true })) -contains 'manual')
Check 'empty state refuses on every count' ((Codes @{}).Count -ge 6)
Check 'Pacific hour from UTC (18:00Z on 2026-11-20 is 10)' ((Get-PacificHour ([datetime]::new(2026, 11, 20, 18, 0, 0, [DateTimeKind]::Utc))) -eq 10)
Check 'Pacific day rolls at local midnight' ((Get-PacificDay ([datetime]::new(2026, 11, 21, 7, 30, 0, [DateTimeKind]::Utc))) -eq '2026-11-20')

# per-job encryption
$k = New-JobKey
$plain = [Text.Encoding]::UTF8.GetBytes('RIFF fake wav and metadata.csv ' * 1000)
$sealed = Protect-Bytes $plain $k
Check 'sealed file starts CFW1 and holds no plaintext' (([Text.Encoding]::ASCII.GetString($sealed, 0, 4) -eq 'CFW1') -and -not ([Text.Encoding]::UTF8.GetString($sealed).Contains('metadata.csv')))
Check 'round trip with the job key' ([Linq.Enumerable]::SequenceEqual([byte[]](Unprotect-Bytes $sealed $k), [byte[]]$plain))
$other = New-JobKey
$threw = $false; try { Unprotect-Bytes $sealed $other | Out-Null } catch { $threw = $true }
Check 'another job key cannot open it' $threw
$bad = [byte[]]$sealed.Clone(); $bad[40] = $bad[40] -bxor 1
$threw = $false; try { Unprotect-Bytes $bad $k | Out-Null } catch { $threw = $true }
Check 'a modified file is refused' $threw
Check 'two seals of the same data differ (fresh nonce)' (-not [Linq.Enumerable]::SequenceEqual([byte[]](Protect-Bytes $plain $k), [byte[]]$sealed))
Clear-Key $k
Check 'Clear-Key zeroes the key' (($k | Measure-Object -Maximum).Maximum -eq 0)

# owner-only folder
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("vw-test-" + [guid]::NewGuid().ToString('N'))
Check 'owner-only folder is created and reads back owner-only' (New-OwnerOnlyDir $tmp)
$acl = Get-Acl $tmp
Check 'inheritance is off' $acl.AreAccessRulesProtected
Check 'exactly one rule, for this user' ((@($acl.Access).Count -eq 1) -and (@($acl.Access)[0].IdentityReference.Value -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().Name))
$loose = Join-Path ([IO.Path]::GetTempPath()) ("vw-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $loose | Out-Null
Check 'an ordinary (inherited ACL) folder fails the check' (-not (Test-OwnerOnlyDir $loose))
Check 'a missing folder fails the check' (-not (Test-OwnerOnlyDir (Join-Path $tmp 'nope')))
Remove-Item -Recurse -Force $tmp, $loose
"$fail failure(s)"
exit $fail
