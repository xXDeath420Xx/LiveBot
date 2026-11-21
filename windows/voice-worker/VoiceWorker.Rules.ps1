# CertiFried voice worker: the rules for when the PC may train (owner decisions of 2026-11-20). Pure functions,
# dot-sourced by voice-worker.ps1 and voice-worker.tests.ps1, so every refusal condition is tested with simulated input.
#
#   Test-VoiceBlockers $state  -> array of @{ Code; Hard; ClearMinutes; Text }   (empty = may train)
#
# $state keys (all optional; a missing value counts against training):
#   ScratchOk        [bool]   the owner-only Windows job folder (ACL: this user only) and the WSL scratch folder (0700, ext4,
#                             owned by the WSL user) exist and read back that way; per-job encryption depends on them
#   PacificHour      [int]    0..23, Pacific time
#   GpuSecondsToday  [int]    GPU seconds used today (Pacific day)
#   ObsRunning       [bool]   obs64.exe is running (treated as live: the owner never trains while streaming or recording)
#   ServerPause      [string] the server's pause reason from a lease or heartbeat (owner_live, outside_window, daily_cap)
#   DenyRunning      [string[]] deny-listed processes that are running (games, editors, Studio renders)
#   GpuUtil          [int]    % utilisation from nvidia-smi
#   GpuUsedMb        [int]    memory used
#   GpuFreeMb        [int]    memory free
#   GpuTempC         [int]
#   OllamaModels     [int]    models Ollama has loaded (api/ps); any means Ollama is in use, and Ollama always wins
#   Training         [bool]   our own training is running (its own GPU use is then expected)
#   ManualPause      [bool]   the pause file exists (voice-worker.ps1 -Pause)
#   Config           hashtable: StartHour (2), EndHour (14), MaxSecondsPerDay (14400), MaxIdleUtil (15), MaxIdleUsedMb (3000),
#                    MinFreeMbTraining (512), MaxTempC (83)

function Get-VoiceRuleConfig([hashtable]$c) {
    $d = @{ StartHour = 2; EndHour = 14; MaxSecondsPerDay = 14400; MaxIdleUtil = 15; MaxIdleUsedMb = 3000; MinFreeMbTraining = 512; MaxTempC = 83 }
    if ($c) { foreach ($k in $c.Keys) { $d[$k] = $c[$k] } }
    return $d
}

function Test-VoiceBlockers([hashtable]$s) {
    $c = Get-VoiceRuleConfig $s.Config
    $out = [System.Collections.Generic.List[hashtable]]::new()
    $add = { param($code, $hard, $clear, $text) $out.Add(@{ Code = $code; Hard = $hard; ClearMinutes = $clear; Text = $text }) }

    if ($s.ScratchOk -ne $true) { & $add 'scratch' $true 0 'The owner-only scratch folders could not be created or checked: the worker refuses to run.' }
    if ($s.ManualPause -eq $true) { & $add 'manual' $true 0 'Paused by hand.' }
    $h = $s.PacificHour
    if ($null -eq $h -or $h -lt $c.StartHour -or $h -ge $c.EndHour) { & $add 'outside_window' $false 0 "Outside $($c.StartHour):00-$($c.EndHour):00 Pacific." }
    if ($null -eq $s.GpuSecondsToday -or $s.GpuSecondsToday -ge $c.MaxSecondsPerDay) { & $add 'daily_cap' $false 0 'Used today''s GPU hours.' }
    if ($s.ObsRunning -ne $false) { & $add 'owner_live' $true 30 'OBS is open (the owner may be live or recording).' }
    if ($s.ServerPause) { & $add ([string]$s.ServerPause) $true ($(if ($s.ServerPause -eq 'owner_live') { 30 } else { 10 })) "The server says: $($s.ServerPause)." }
    if ($s.DenyRunning -and @($s.DenyRunning).Count -gt 0) { & $add 'game' $true 10 ("Running: " + (@($s.DenyRunning) -join ', ')) }
    if ($null -eq $s.OllamaModels -or $s.OllamaModels -gt 0) { & $add 'ollama' $true 15 'Ollama has a model loaded (or could not be asked).' }
    if ($null -eq $s.GpuUtil -or $null -eq $s.GpuFreeMb) { & $add 'gpu_unknown' $true 10 'nvidia-smi did not answer.' }
    elseif ($s.Training -eq $true) {
        if ($s.GpuFreeMb -lt $c.MinFreeMbTraining) { & $add 'gpu_busy' $true 10 'Another program needs the GPU memory.' }
    } else {
        if ($s.GpuUtil -gt $c.MaxIdleUtil -or $s.GpuUsedMb -gt $c.MaxIdleUsedMb) { & $add 'gpu_busy' $true 10 "The GPU is busy ($($s.GpuUtil)% , $($s.GpuUsedMb) MB used)." }
    }
    if ($null -ne $s.GpuTempC -and $s.GpuTempC -ge $c.MaxTempC) { & $add 'hot' $false 15 "GPU at $($s.GpuTempC) C." }
    return , $out.ToArray()
}

function Get-PacificHour([datetime]$utc = [datetime]::UtcNow) {
    return [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($utc, 'Pacific Standard Time').Hour
}
function Get-PacificDay([datetime]$utc = [datetime]::UtcNow) {
    return [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($utc, 'Pacific Standard Time').ToString('yyyy-MM-dd')
}
