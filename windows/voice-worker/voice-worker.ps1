# CertiFried voice worker: trains own voices on this PC's GPU for the CertiFried server (invite-only own-voice feature).
#
# What it does, in order, and only when every rule in VoiceWorker.Rules.ps1 allows it:
#   1. refuses to run at all unless it can create and verify its scratch folders: the Windows job folder with an
#      owner-only ACL (this user only, inheritance off) and the WSL scratch folder ~/voice-work (0700, ext4, our user);
#   2. between 02:00 and 14:00 Pacific, at most 4 GPU-hours a day, never while OBS is open or the server says the owner is
#      live (the cf_quiet query), never with a deny-listed game or editor, GPU load or a loaded Ollama model;
#   3. opens its own SSH local forward (127.0.0.1:18650 -> server 127.0.0.1:4650; nothing on this PC listens) and asks
#      for a job. Each job gets a random 32-byte key held only in this process's memory (VoiceWorker.Crypto.ps1):
#        - the dataset is downloaded into memory and stored only as dataset.cfw1 (AES-256-GCM) in the job folder;
#        - for training it is decrypted in memory and piped straight into tar in the WSL scratch folder, because piper1-gpl
#          reads plain WAV files; that folder is shredded the moment training stops, ends or fails, and at every start;
#        - a paused run's last checkpoint is piped out, stored as checkpoint.cfw1, and the scratch folder shredded;
#        - the trained model is piped out, stored as model.onnx.cfw1 / model.onnx.json.cfw1, and decrypted only in memory
#          for the upload;
#      then the job folders are wiped, the key zeroed, and the server sent a purge receipt.
#
# Files (all under %LOCALAPPDATA%\CertiFriedVoiceWorker): worker.json (settings), token.dpapi (VOICE_WORKER_TOKEN,
# DPAPI-encrypted for this Windows user), worker.log, state.json (GPU seconds today), pause (exists = paused), jobs\<id>.
#
#   pwsh -File voice-worker.ps1            run (the Scheduled Task does this every 15 minutes; one copy at a time)
#   pwsh -File voice-worker.ps1 -Check     print what would stop it right now, and exit
#   pwsh -File voice-worker.ps1 -Pause / -Resume
# It never changes power limits, driver settings or any system setting.
param([switch]$Check, [switch]$Pause, [switch]$Resume, [switch]$Once)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 1   # (answers from the server leave out keys they do not need: cancel, pause)
. (Join-Path $PSScriptRoot 'VoiceWorker.Rules.ps1')
. (Join-Path $PSScriptRoot 'VoiceWorker.Crypto.ps1')

$Dir = Join-Path $env:LOCALAPPDATA 'CertiFriedVoiceWorker'
$Jobs = Join-Path $Dir 'jobs'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$LogFile = Join-Path $Dir 'worker.log'
$PauseFile = Join-Path $Dir 'pause'
if ($Pause) { New-Item -ItemType File -Force -Path $PauseFile | Out-Null; 'Paused.'; exit 0 }
if ($Resume) { Remove-Item -Force -ErrorAction SilentlyContinue $PauseFile; 'Resumed.'; exit 0 }

function Log([string]$m) {
    try {
        if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item -Force $LogFile "$LogFile.1" }
        Add-Content -Path $LogFile -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $m) -Encoding utf8
    } catch { }
}

$Cfg = @{
    Server = 'death@server.certifriedmultitool.com'; SshKey = (Join-Path $env:USERPROFILE '.ssh\id_ed25519')
    LocalPort = 18650; RemotePort = 4650; Distro = 'Ubuntu'; WslWork = '~/voice-work'
    WslScript = '~/voice-lab/certifried-worker/train_job.sh'; WslBase = '~/voice-lab/base/libritts_r-medium/best.ckpt'
    BaseSha256 = 'e0f93367abeb352bdc2190415a8b8a98f6128cfc0f549407aa80aca80bcbc1af'
    Deny = @('FortniteClient-Win64-Shipping', 'RDR2', 'Subnautica2', 'UnrealEditor', 'Unity', 'Windrose', 'NightRunner', 'HavendockClient', 'blender', 'Resolve')
    Rules = @{}
}
$cfgFile = Join-Path $Dir 'worker.json'
if (Test-Path $cfgFile) { $j = Get-Content $cfgFile -Raw | ConvertFrom-Json -AsHashtable; foreach ($k in $j.Keys) { $Cfg[$k] = $j[$k] } }
$Api = "http://127.0.0.1:$($Cfg.LocalPort)"

# ── WSL, with binary stdin / stdout (pipes, never files) ──
function Invoke-Wsl([string]$cmd, [byte[]]$In = $null) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new('wsl.exe')
    foreach ($a in @('-d', $Cfg.Distro, '--exec', 'bash', '-c', $cmd)) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $ms = [System.IO.MemoryStream]::new()
    $copy = $p.StandardOutput.BaseStream.CopyToAsync($ms)
    $err = $p.StandardError.ReadToEndAsync()
    try { if ($In) { $p.StandardInput.BaseStream.Write($In, 0, $In.Length) } } finally { $p.StandardInput.Close() }
    $copy.Wait(); $p.WaitForExit()
    return @{ Code = $p.ExitCode; Out = $ms.ToArray(); Text = [Text.Encoding]::UTF8.GetString($ms.ToArray()).Trim(); Err = $err.Result }
}

# ── scratch folders (the condition that replaces BitLocker) ──
function Test-ScratchReady {
    if (-not (New-OwnerOnlyDir $Jobs)) { return $false }
    $r = Invoke-Wsl "umask 077; mkdir -p $($Cfg.WslWork) && chmod 700 $($Cfg.WslWork) && printf '%s %s %s %s' `$(stat -c '%a %U' $($Cfg.WslWork)) `$(whoami) `$(stat -f -c %T $($Cfg.WslWork))"
    $v = $r.Text -split '\s+'
    return ($r.Code -eq 0 -and $v.Count -ge 4 -and $v[0] -eq '700' -and $v[1] -eq $v[2] -and $v[3] -match '^ext')
}
function Clear-Scratch([string]$jobId) {
    # shred every file, then remove the folder; returns "files bytes"
    $d = if ($jobId) { "$($Cfg.WslWork)/$jobId" } else { "$($Cfg.WslWork)/*" }
    $r = Invoke-Wsl "n=0; b=0; for x in $d; do [ -e `$x ] || continue; n=`$((n + `$(find `$x -type f | wc -l))); b=`$((b + `$(du -sb `$x | cut -f1))); find `$x -type f -exec shred -u -n 1 {} + 2>/dev/null; rm -rf `$x; done; echo `$n `$b"
    $nb = $r.Text -split '\s+'
    return @{ files = [int]$nb[0]; bytes = [int64]$nb[1] }
}

# ── inputs to the rules ──
function Get-GpuState {
    try {
        $line = (& nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.free,temperature.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
        $v = $line -split ',\s*'
        return @{ GpuUtil = [int]$v[0]; GpuUsedMb = [int]$v[1]; GpuFreeMb = [int]$v[2]; GpuTempC = [int]$v[3] }
    } catch { return @{ GpuUtil = $null; GpuUsedMb = $null; GpuFreeMb = $null; GpuTempC = $null } }
}
function Get-OllamaModels {
    try { return @((Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/ps' -TimeoutSec 3).models).Count } catch {
        if ($_.Exception.Message -match 'actively refused|No connection could be made|Unable to connect') { return 0 }   # not running: nothing loaded
        return $null
    }
}
function Get-StateFile { $f = Join-Path $Dir 'state.json'; if (Test-Path $f) { Get-Content $f -Raw | ConvertFrom-Json -AsHashtable } else { @{} } }
function Add-GpuSeconds([int]$s) {
    $st = Get-StateFile; $day = Get-PacificDay
    if ($st['day'] -ne $day) { $st = @{ day = $day; seconds = 0 } }
    $st['seconds'] = [int]$st['seconds'] + $s
    $st | ConvertTo-Json | Set-Content -Path (Join-Path $Dir 'state.json') -Encoding utf8
}
function Get-GpuSecondsToday { $st = Get-StateFile; if ($st['day'] -eq (Get-PacificDay)) { [int]$st['seconds'] } else { 0 } }
$script:ScratchChecked = $null
function Get-RuleState([bool]$training, [string]$serverPause) {
    if ($null -eq $script:ScratchChecked) { $script:ScratchChecked = Test-ScratchReady }
    $names = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName })
    $g = Get-GpuState
    return @{
        ScratchOk = $script:ScratchChecked; PacificHour = (Get-PacificHour); GpuSecondsToday = (Get-GpuSecondsToday)
        ObsRunning = ($names -contains 'obs64'); ServerPause = $serverPause
        DenyRunning = @($Cfg.Deny | Where-Object { $names -contains $_ })
        GpuUtil = $g.GpuUtil; GpuUsedMb = $g.GpuUsedMb; GpuFreeMb = $g.GpuFreeMb; GpuTempC = $g.GpuTempC
        OllamaModels = (Get-OllamaModels); Training = $training; ManualPause = (Test-Path $PauseFile); Config = $Cfg.Rules
    }
}

if ($Check) {
    $b = Test-VoiceBlockers (Get-RuleState $false $null)
    if ($b.Count -eq 0) { 'Nothing stops training right now.' } else { $b | ForEach-Object { "{0,-15} {1}" -f $_.Code, $_.Text } }
    if ($script:ScratchChecked) { "scratch         ok: $Jobs (owner-only ACL) and WSL $($Cfg.WslWork) (0700, ext4); per-job AES-256-GCM key in memory" }
    exit 0
}

$mutex = [System.Threading.Mutex]::new($false, 'Local\CertiFriedVoiceWorker')
if (-not $mutex.WaitOne(0)) { exit 0 }

# ── server access ──
function Get-Token {
    $f = Join-Path $Dir 'token.dpapi'
    $pending = Join-Path $Dir 'secret\token.pending'
    if (Test-Path $pending) {
        $tok = [IO.File]::ReadAllText($pending).Trim()
        try {
            ConvertTo-SecureString $tok -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -Path $f -Encoding ascii
            Remove-Item -Force $pending
            Log 'token moved into DPAPI'
        } catch { Log 'DPAPI unavailable: the token stays in the owner-only secret folder'; return $tok }
    }
    if (-not (Test-Path $f)) { throw 'No token: run install.ps1 first.' }
    return [System.Net.NetworkCredential]::new('', (Get-Content $f -Raw | ConvertTo-SecureString)).Password
}
$Token = Get-Token
$script:Tunnel = $null
function Open-Tunnel {
    if ($script:Tunnel -and -not $script:Tunnel.HasExited) { return }
    $sshArgs = @('-i', $Cfg.SshKey, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
        '-N', '-L', "127.0.0.1:$($Cfg.LocalPort):127.0.0.1:$($Cfg.RemotePort)", $Cfg.Server)
    $script:Tunnel = Start-Process -FilePath 'ssh' -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 4
}
function Close-Tunnel { if ($script:Tunnel -and -not $script:Tunnel.HasExited) { Stop-Process -Id $script:Tunnel.Id -Force -ErrorAction SilentlyContinue }; $script:Tunnel = $null }
function Call([string]$method, [string]$path, $body = $null, [string]$lease = $null) {
    $h = @{ Authorization = "Bearer $Token" }
    if ($lease) { $h['X-Lease-Token'] = $lease }
    $p = @{ Method = $method; Uri = "$Api$path"; Headers = $h; TimeoutSec = 60 }
    if ($null -ne $body) { $p.Body = ($body | ConvertTo-Json -Compress -Depth 5); $p.ContentType = 'application/json' }
    return Invoke-RestMethod @p
}
function Get-Bytes([string]$path, [string]$lease) {
    $c = [System.Net.Http.HttpClient]::new(); $c.Timeout = [TimeSpan]::FromMinutes(10)
    try {
        $req = [System.Net.Http.HttpRequestMessage]::new('GET', "$Api$path")
        $req.Headers.Add('Authorization', "Bearer $Token"); $req.Headers.Add('X-Lease-Token', $lease)
        $res = $c.SendAsync($req).GetAwaiter().GetResult()
        if (-not $res.IsSuccessStatusCode) { throw "dataset: HTTP $([int]$res.StatusCode)" }
        return , $res.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    } finally { $c.Dispose() }
}

# ── one job ──
function Stop-Training([string]$jobId, $proc) {
    Invoke-Wsl "f=$($Cfg.WslWork)/$jobId/train.pid; [ -s `$f ] && kill -TERM -- -`$(cat `$f) 2>/dev/null; sleep 20; [ -s `$f ] && kill -KILL -- -`$(cat `$f) 2>/dev/null; true" | Out-Null
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
function Save-Checkpoint([string]$jobId, [byte[]]$key, [string]$win) {
    $r = Invoke-Wsl "cd $($Cfg.WslWork)/$jobId 2>/dev/null && ck=`$(ls -t train/lightning_logs/version_*/checkpoints/last.ckpt 2>/dev/null | head -1) && [ -s `${ck:-/none} ] && tar -cf - `$ck train/config.json"
    if ($r.Code -eq 0 -and $r.Out.Length -gt 0) { [IO.File]::WriteAllBytes((Join-Path $win 'checkpoint.cfw1'), (Protect-Bytes $r.Out $key)); return $true }
    return $false
}
function Restore-Scratch([string]$jobId, [byte[]]$key, [string]$win) {
    $d = "$($Cfg.WslWork)/$jobId"
    $mk = Invoke-Wsl "umask 077; rm -rf $d; mkdir -p $d/dataset && chmod 700 $d"
    if ($mk.Code -ne 0) { throw 'could not create the WSL scratch folder' }
    $tar = Unprotect-Bytes ([IO.File]::ReadAllBytes((Join-Path $win 'dataset.cfw1'))) $key
    try { $x = Invoke-Wsl "umask 077; tar -xf - -C $d/dataset" $tar } finally { [Array]::Clear($tar, 0, $tar.Length) }
    if ($x.Code -ne 0) { throw "dataset unpack failed: $($x.Err)" }
    $ckf = Join-Path $win 'checkpoint.cfw1'
    if (Test-Path $ckf) {
        $ck = Unprotect-Bytes ([IO.File]::ReadAllBytes($ckf)) $key
        try { Invoke-Wsl "umask 077; tar -xf - -C $d" $ck | Out-Null } finally { [Array]::Clear($ck, 0, $ck.Length) }
    }
}
function Start-Training([string]$jobId, [int]$steps, [string]$espeak = 'en-us') {
    if ($espeak -notmatch '^[a-z][a-z0-9-]{1,30}$') { $espeak = 'en-us' }
    $cmd = "umask 077; setsid --wait bash $($Cfg.WslScript) $($Cfg.WslWork)/$jobId $steps $($Cfg.WslBase) $espeak"
    return Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Cfg.Distro, '--exec', 'bash', '-c', $cmd) -WindowStyle Hidden -PassThru
}
function Invoke-Job($job) {
    $id = [string]$job.job_id; $lt = [string]$job.lease_token; $steps = [int]$job.steps
    Log "job $id leased (attempt $($job.attempt))"
    $key = New-JobKey
    $win = Join-Path $Jobs $id
    $proc = $null; $paused = $null; $clearAt = [datetime]::MinValue; $lastBeat = [datetime]::MinValue; $serverPause = $null
    $outcome = 'failed'; $failReason = $null; $scratchLive = $false
    try {
        if (-not (New-OwnerOnlyDir $win)) { throw 'could not create the owner-only job folder' }
        $tar = Get-Bytes "/v1/jobs/$id/dataset" $lt
        [IO.File]::WriteAllBytes((Join-Path $win 'dataset.cfw1'), (Protect-Bytes $tar $key))
        [Array]::Clear($tar, 0, $tar.Length); $tar = $null
        while ($true) {
            $running = $proc -and -not $proc.HasExited
            $blockers = Test-VoiceBlockers (Get-RuleState $running $serverPause)
            if ($blockers.Count -gt 0) {
                if ($running) {
                    Log "job ${id}: stopping ($(($blockers | ForEach-Object Code) -join ', '))"
                    Stop-Training $id $proc; $proc = $null
                }
                if ($scratchLive) { $saved = Save-Checkpoint $id $key $win; Clear-Scratch $id | Out-Null; $scratchLive = $false; Log "job ${id}: scratch shredded (checkpoint kept encrypted: $saved)" }
                $paused = ($blockers | Select-Object -First 1).Code
                $clearAt = (Get-Date).AddMinutes([double](($blockers | Measure-Object -Property ClearMinutes -Maximum).Maximum))
                if ($blockers | Where-Object Code -eq 'scratch') { $failReason = 'the scratch folders could not be checked'; break }
                # the day's window or GPU hours ended: hand the job back and wipe now rather than keep anything overnight
                if ($blockers | Where-Object { $_.Code -in @('outside_window', 'daily_cap') }) { $failReason = 'the training window ended before the voice was finished; it starts again in the next window'; break }
            } elseif (-not $running -and (Get-Date) -ge $clearAt) {
                Restore-Scratch $id $key $win; $scratchLive = $true
                Log "job ${id}: training starts"
                $proc = Start-Training $id $steps ([string]$job.espeak_voice); $paused = $null; $serverPause = $null
            }
            if (((Get-Date) - $lastBeat).TotalSeconds -ge 30) {
                $gpuDelta = if ($running -and $lastBeat -ne [datetime]::MinValue) { [int][math]::Min(90, ((Get-Date) - $lastBeat).TotalSeconds) } else { 0 }
                if ($gpuDelta -gt 0) { Add-GpuSeconds $gpuDelta }
                $prog = (Invoke-Wsl "cat $($Cfg.WslWork)/$id/progress 2>/dev/null || echo 0 $steps").Text -split '\s+'
                try {
                    $r = Call 'POST' "/v1/jobs/$id/heartbeat" @{ state = $(if ($running) { 'running' } else { 'paused' }); step = [int]$prog[0]; total_steps = [int]$prog[1]; pause_reason = $paused; gpu_seconds = $gpuDelta } $lt
                    if ($r.cancel) { Log "job ${id}: cancelled by the server ($($r.reason))"; if ($running) { Stop-Training $id $proc }; $outcome = 'cancelled'; break }
                    $serverPause = if ($r.pause) { [string]$r.pause } else { $null }
                } catch { Log "job ${id}: heartbeat failed: $($_.Exception.Message)"; Open-Tunnel }
                $lastBeat = Get-Date
            }
            if ($proc -and $proc.HasExited) {
                if ((Invoke-Wsl "[ -f $($Cfg.WslWork)/$id/done ] && echo yes || echo no").Text -eq 'yes') { $outcome = 'upload'; break }
                $failReason = "training stopped (exit $($proc.ExitCode))"; break
            }
            Start-Sleep -Seconds 15
        }
        if ($outcome -eq 'upload') {
            # model out of WSL through a pipe, encrypted at rest until the upload, scratch shredded before uploading
            foreach ($f in 'model.onnx', 'model.onnx.json') {
                $r = Invoke-Wsl "cat $($Cfg.WslWork)/$id/export/$f"
                if ($r.Code -ne 0 -or $r.Out.Length -eq 0) { throw "export missing: $f" }
                [IO.File]::WriteAllBytes((Join-Path $win "$f.cfw1"), (Protect-Bytes $r.Out $key))
            }
            Clear-Scratch $id | Out-Null; $scratchLive = $false
            foreach ($part in @(@{ name = 'onnx'; file = 'model.onnx' }, @{ name = 'json'; file = 'model.onnx.json' })) {
                $bytes = Unprotect-Bytes ([IO.File]::ReadAllBytes((Join-Path $win "$($part.file).cfw1"))) $key
                $sha = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLower()
                $r = Invoke-RestMethod -Method Put -Uri "$Api/v1/jobs/$id/artifact?part=$($part.name)" -Headers @{ Authorization = "Bearer $Token"; 'X-Lease-Token' = $lt; 'X-SHA256' = $sha } -Body $bytes -ContentType 'application/octet-stream' -TimeoutSec 600
                [Array]::Clear($bytes, 0, $bytes.Length)
                Log "job ${id}: uploaded $($part.name) ($($r | ConvertTo-Json -Compress))"
            }
            $outcome = 'done'
        }
        if ($outcome -eq 'failed') {
            Log "job ${id}: failed: $failReason"
            try { Call 'POST' "/v1/jobs/$id/fail" @{ error = [string]$failReason; retryable = ($failReason -notmatch 'scratch') } $lt | Out-Null } catch { }
        }
    } catch {
        Log "job ${id}: error: $($_.Exception.Message)"
        try { Call 'POST' "/v1/jobs/$id/fail" @{ error = $_.Exception.Message; retryable = $true } $lt | Out-Null } catch { }
    } finally {
        if ($proc -and -not $proc.HasExited) { Stop-Training $id $proc }
        $w = Clear-Scratch $id
        $files = $w.files; $bytesN = $w.bytes
        if (Test-Path $win) { Get-ChildItem -Recurse -File $win | ForEach-Object { $files++; $bytesN += $_.Length }; Remove-Item -Recurse -Force $win }
        Clear-Key $key
        Log "job ${id}: wiped $files files ($bytesN bytes); key zeroed"
        try { Call 'POST' "/v1/jobs/$id/purged" @{ files_removed = $files; bytes = $bytesN } $lt | Out-Null } catch { Log "job ${id}: purge receipt not sent: $($_.Exception.Message)" }
    }
}

# ── main loop ──
Log 'worker started'
try {
    # sweep anything a crash left behind: shred the WSL scratch, delete the (encrypted) job folders whose keys are gone
    Clear-Scratch $null | Out-Null
    if (Test-Path $Jobs) { Get-ChildItem $Jobs -Directory -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -Recurse -Force $_.FullName } }
    if (-not (Test-ScratchReady)) { Log 'refusing to run: could not create the owner-only scratch folders'; exit 2 }
    $script:ScratchChecked = $true
    if ((Invoke-Wsl "f=$($Cfg.WslBase); echo '$($Cfg.BaseSha256)  '`$f | sha256sum -c --status && echo ok || echo bad").Text -ne 'ok') { Log 'refusing to run: the LibriTTS-R base checkpoint is missing or its SHA-256 does not match (run install.ps1)'; exit 3 }
    while ($true) {
        $script:ScratchChecked = Test-ScratchReady
        $blockers = Test-VoiceBlockers (Get-RuleState $false $null)
        if ($blockers | Where-Object Code -eq 'scratch') { Log 'refusing to run: the scratch folders failed their check'; exit 2 }
        if ($blockers.Count -eq 0) {
            Open-Tunnel
            try {
                $g = Get-GpuState
                $r = Call 'POST' '/v1/lease' @{ worker_id = $env:COMPUTERNAME; version = '1.1.0'; gpu = @{ util_pct = $g.GpuUtil; vram_free_mb = $g.GpuFreeMb }; local = @{ scratch_encrypted = $true } }
                if ($r.job) { Invoke-Job $r.job } elseif ($r.refusal) { Log "no lease: $($r.refusal)"; Close-Tunnel; Start-Sleep -Seconds 600 }
            } catch { Log "lease failed: $($_.Exception.Message)"; Close-Tunnel }
        } else { Close-Tunnel }
        if ($Once) { break }
        Start-Sleep -Seconds 60
    }
} finally {
    Close-Tunnel
    $mutex.ReleaseMutex()
    Log 'worker stopped'
}
