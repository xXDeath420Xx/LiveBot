# CertiFried voice worker: per-job encryption of the scratch workspace (owner decision 2026-11-21, replacing the
# BitLocker requirement). Dot-sourced by voice-worker.ps1, install.ps1 and voice-worker.tests.ps1.
#
#   New-JobKey                         32 random bytes, held only in the worker's memory for one job
#   Protect-Bytes $plain $key          "CFW1" | nonce 12 | tag 16 | ciphertext   (AES-256-GCM)
#   Unprotect-Bytes $sealed $key       throws on a wrong key or a modified file
#   Clear-Key $key                     zero the key
#   New-OwnerOnlyDir $path             create a folder only this Windows user can open (inheritance off, one ACE: the
#                                      current user, full control) and return $true only if the ACL reads back that way
#   Test-OwnerOnlyDir $path
# The dataset, the paused-training checkpoint and the trained model are stored only as CFW1 files. Plain files exist
# only in the WSL scratch folder (~/voice-work/<job>, mode 0700, ext4) while piper1-gpl is reading or writing them, and
# are shredded the moment training stops, ends or fails, and at every worker start.

function New-JobKey {
    $k = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($k)
    return , $k
}

function Clear-Key([byte[]]$key) { if ($key) { [Array]::Clear($key, 0, $key.Length) } }

function Protect-Bytes([byte[]]$plain, [byte[]]$key) {
    $nonce = [byte[]]::new(12)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($nonce)
    $ct = [byte[]]::new($plain.Length)
    $tag = [byte[]]::new(16)
    $g = [System.Security.Cryptography.AesGcm]::new($key, 16)
    try { $g.Encrypt($nonce, $plain, $ct, $tag) } finally { $g.Dispose() }
    $out = [byte[]]::new(32 + $ct.Length)
    [Buffer]::BlockCopy([Text.Encoding]::ASCII.GetBytes('CFW1'), 0, $out, 0, 4)
    [Buffer]::BlockCopy($nonce, 0, $out, 4, 12)
    [Buffer]::BlockCopy($tag, 0, $out, 16, 16)
    [Buffer]::BlockCopy($ct, 0, $out, 32, $ct.Length)
    return , $out
}

function Unprotect-Bytes([byte[]]$sealed, [byte[]]$key) {
    if ($sealed.Length -lt 32 -or [Text.Encoding]::ASCII.GetString($sealed, 0, 4) -ne 'CFW1') { throw 'not a CFW1 file' }
    $nonce = [byte[]]::new(12); [Buffer]::BlockCopy($sealed, 4, $nonce, 0, 12)
    $tag = [byte[]]::new(16); [Buffer]::BlockCopy($sealed, 16, $tag, 0, 16)
    $ct = [byte[]]::new($sealed.Length - 32); [Buffer]::BlockCopy($sealed, 32, $ct, 0, $ct.Length)
    $plain = [byte[]]::new($ct.Length)
    $g = [System.Security.Cryptography.AesGcm]::new($key, 16)
    try { $g.Decrypt($nonce, $ct, $tag, $plain) } finally { $g.Dispose() }
    return , $plain
}

function Test-OwnerOnlyDir([string]$path) {
    try {
        $acl = Get-Acl -LiteralPath $path
        if (-not $acl.AreAccessRulesProtected) { return $false }
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        if ($rules.Count -lt 1) { return $false }
        foreach ($r in $rules) {
            if ($r.IdentityReference -ne $me) { return $false }
            if ($r.AccessControlType -ne 'Allow') { return $false }
        }
        return $true
    } catch { return $false }
}

function New-OwnerOnlyDir([string]$path) {
    try {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = [System.Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($me, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
        # .NET writes only the DACL (Set-Acl also tries the SACL, which needs SeSecurityPrivilege)
        [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($path), $acl)
        return (Test-OwnerOnlyDir $path)
    } catch { return $false }
}
