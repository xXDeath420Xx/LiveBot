# Installs the CertiFried voice worker for THIS Windows user (no admin rights, no system settings changed).
#
#   pwsh -NoProfile -File install.ps1             check the scratch folders, install, register the per-user Scheduled Task
#   pwsh -NoProfile -File install.ps1 -Uninstall  remove the task and the worker folder (job folders included)
#
# Steps, in order; it stops at the first one that fails:
#   1. Creates the scratch folders and checks them: %LOCALAPPDATA%\CertiFriedVoiceWorker\jobs with an owner-only ACL
#      (inheritance off, this user only) and WSL ~/voice-work (0700, ext4). If either fails, nothing is installed.
#      (Per-job AES-256-GCM encryption of the workspace replaces the earlier BitLocker requirement: owner decision 2026-11-21.)
#   2. Copies voice-worker.ps1, VoiceWorker.Rules.ps1, VoiceWorker.Crypto.ps1 and the tests to %LOCALAPPDATA%\CertiFriedVoiceWorker\bin, and
#      train_job.sh to WSL ~/voice-lab/certifried-worker/.
#   3. Reads VOICE_WORKER_TOKEN from the server's .env over SSH and stores it DPAPI-encrypted for this user
#      (token.dpapi). It is never printed.
#   4. Downloads the LibriTTS-R base checkpoint (933 MB, CC BY 4.0) into WSL ~/voice-lab/base/libritts_r-medium/ and
#      checks its SHA-256.
#   5. Runs the rule tests, then registers the Scheduled Task "CertiFried-VoiceWorker" (every 15 minutes, as this user,
#      only when logged on; the worker keeps one copy running and sleeps outside 02:00-14:00 Pacific). It uses the
#      WindowsApps pwsh.exe alias, which survives PowerShell updates.
param([switch]$Uninstall, [string]$Server = 'death@server.certifriedmultitool.com')
$ErrorActionPreference = 'Stop'
$Src = $PSScriptRoot
$Dir = Join-Path $env:LOCALAPPDATA 'CertiFriedVoiceWorker'
$Bin = Join-Path $Dir 'bin'
$Task = 'CertiFried-VoiceWorker'
$Pwsh = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
$Sha = 'e0f93367abeb352bdc2190415a8b8a98f6128cfc0f549407aa80aca80bcbc1af'
$Url = 'https://huggingface.co/datasets/rhasspy/piper-checkpoints/resolve/main/en/en_US/libritts_r/medium/best.ckpt'
. (Join-Path $Src 'VoiceWorker.Rules.ps1')
. (Join-Path $Src 'VoiceWorker.Crypto.ps1')

if ($Uninstall) {
    & schtasks.exe /Delete /TN $Task /F 2>$null | Out-Null
    if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
    & wsl.exe -d Ubuntu --exec bash -c 'rm -rf ~/voice-work ~/voice-lab/certifried-worker' | Out-Null
    'Removed the task, the worker folder and the WSL job folders. The base checkpoint stays in ~/voice-lab/base/libritts_r-medium.'
    exit 0
}

# 1. scratch folders
if (-not (New-OwnerOnlyDir (Join-Path $Dir 'jobs'))) { 'STOP: could not create an owner-only folder under ' + $Dir + '. Nothing was installed.'; exit 2 }
$w = (& wsl.exe -d Ubuntu --exec bash -c 'umask 077; mkdir -p ~/voice-work && chmod 700 ~/voice-work && echo $(stat -c ''%a %U'' ~/voice-work) $(whoami) $(stat -f -c %T ~/voice-work)') -split '\s+'
if (-not ($w.Count -ge 4 -and $w[0] -eq '700' -and $w[1] -eq $w[2] -and $w[3] -match '^ext')) { "STOP: the WSL scratch folder ~/voice-work is not 0700 on ext4 ($($w -join ' ')). Nothing was installed."; exit 2 }
'Scratch: owner-only job folder and WSL ~/voice-work (0700, ext4) ready; each job is encrypted with its own in-memory key.'
# 2. files
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
foreach ($f in 'voice-worker.ps1', 'VoiceWorker.Rules.ps1', 'VoiceWorker.Crypto.ps1', 'voice-worker.tests.ps1') { Copy-Item -Force (Join-Path $Src $f) (Join-Path $Bin $f) }
$shWin = (Join-Path $Src 'train_job.sh') -replace '\\', '/'
$shWsl = (& wsl.exe -d Ubuntu --exec wslpath -a $shWin).Trim()
& wsl.exe -d Ubuntu --exec bash -c "mkdir -p ~/voice-lab/certifried-worker ~/voice-work && chmod 700 ~/voice-work && tr -d '\r' < '$shWsl' > ~/voice-lab/certifried-worker/train_job.sh && chmod 700 ~/voice-lab/certifried-worker/train_job.sh"
'Files: installed.'

# 3. token (never shown)
$tok = (& ssh -o BatchMode=yes $Server "grep -m1 '^VOICE_WORKER_TOKEN=' ~/CertiFriedUtility/.env | cut -d= -f2-").Trim()
if ($tok.Length -lt 32) { throw 'Could not read VOICE_WORKER_TOKEN from the server.' }
try {
    ConvertTo-SecureString $tok -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -Path (Join-Path $Dir 'token.dpapi') -Encoding ascii
} catch {
    # DPAPI can be unavailable to this shell (restricted token): leave the token in an owner-only folder; the worker moves it
    # into DPAPI on its first run under the Scheduled Task and deletes this copy.
    $sec = Join-Path $Dir 'secret'
    if (-not (New-OwnerOnlyDir $sec)) { throw 'Could not create an owner-only folder for the token.' }
    [IO.File]::WriteAllText((Join-Path $sec 'token.pending'), $tok)
}
Remove-Variable tok
'Token: stored for this Windows user only (DPAPI, or an owner-only folder until the worker first runs).'

# 4. base checkpoint
$have = (& wsl.exe -d Ubuntu --exec bash -c "f=~/voice-lab/base/libritts_r-medium/best.ckpt; [ -f `$f ] && echo '$Sha  '`$f | sha256sum -c --status && echo ok || echo no").Trim()
if ($have -ne 'ok') {
    'Base checkpoint: downloading 933 MB...'
    & wsl.exe -d Ubuntu --exec bash -c "mkdir -p ~/voice-lab/base/libritts_r-medium && cd ~/voice-lab/base/libritts_r-medium && curl -sSfL -o best.ckpt.part '$Url' && echo '$Sha  best.ckpt.part' | sha256sum -c --status && mv best.ckpt.part best.ckpt && curl -sSfL -o MODEL_CARD 'https://huggingface.co/datasets/rhasspy/piper-checkpoints/resolve/main/en/en_US/libritts_r/medium/MODEL_CARD'"
    if ($LASTEXITCODE -ne 0) { throw 'The base checkpoint did not download or its SHA-256 did not match.' }
}
'Base checkpoint: present, SHA-256 checked.'

# 5. tests, then the task
& pwsh -NoProfile -File (Join-Path $Bin 'voice-worker.tests.ps1') | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { throw 'The worker rule tests failed: not registering the task.' }
$cmd = "`"$Pwsh`" -NoProfile -WindowStyle Hidden -File `"$(Join-Path $Bin 'voice-worker.ps1')`""
& schtasks.exe /Create /TN $Task /SC MINUTE /MO 15 /TR $cmd /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'schtasks could not create the task.' }
"Scheduled Task '$Task': every 15 minutes as $env:USERNAME. Check it any time with:"
"  pwsh -File `"$(Join-Path $Bin 'voice-worker.ps1')`" -Check"
"Pause / resume: -Pause / -Resume. Log: $(Join-Path $Dir 'worker.log')"
