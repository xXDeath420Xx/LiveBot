<#
  CertiFried Studio voice helper. Offline phrase recognition with Windows' built-in desktop speech recognizer
  (System.Speech, part of .NET Framework on every Windows 10/11; no install, no internet).

  Input:  raw audio on stdin, 16 kHz, 16-bit, mono PCM, sent by CertiFried Studio from the microphone the person
          picked. Nothing is saved; the audio only passes through this process's memory.
  Grammar: the phrases in -GrammarFile (a JSON array of strings). Only these phrases can be recognised.
  Output: one JSON object per line on stdout:
          {"type":"ready","culture":"en-US"} | {"type":"recognized","text":"...","confidence":0.93} | {"type":"stopped"} | {"type":"error","message":"..."}
  Ends when stdin closes (Studio stopped listening).
#>
param(
    [Parameter(Mandatory = $true)][string]$GrammarFile,
    [string]$Culture = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Send($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

try {
    Add-Type -AssemblyName System.Speech
    $phrases = @(Get-Content -Raw -Encoding UTF8 -LiteralPath $GrammarFile | ConvertFrom-Json) | Where-Object { $_ -and $_.Trim() }
    if ($phrases.Count -eq 0) { Send @{ type = 'error'; message = 'no_phrases' }; exit 2 }

    $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
    if ($installed.Count -eq 0) { Send @{ type = 'error'; message = 'no_recognizer' }; exit 3 }
    $info = $null
    if ($Culture) { $info = $installed | Where-Object { $_.Culture.Name -eq $Culture } | Select-Object -First 1 }
    if (-not $info) { $info = $installed | Where-Object { $_.Culture.Name -eq [System.Globalization.CultureInfo]::CurrentUICulture.Name } | Select-Object -First 1 }
    if (-not $info) { $info = $installed | Select-Object -First 1 }

    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
    $choices = New-Object System.Speech.Recognition.Choices
    foreach ($p in $phrases) { [void]$choices.Add([string]$p) }
    $builder = New-Object System.Speech.Recognition.GrammarBuilder($choices)
    $builder.Culture = $info.Culture
    $engine.LoadGrammar((New-Object System.Speech.Recognition.Grammar($builder)))
    $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(400)

    # The recognizer insists on a seekable stream; stdin is a pipe. This wrapper reports itself seekable and simply
    # reads on (the recognizer only reads forward from a live stream).
    Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.IO;
public class CertiFriedPipeAudio : Stream {
    private readonly Stream src; private long pos;
    public CertiFriedPipeAudio(Stream s) { src = s; }
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return -1L; } }
    public override long Position { get { return pos; } set { } }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) { return pos; }
    public override void SetLength(long value) { }
    public bool Ended;
    // Fill the whole request: a short read would make the recognizer think the audio has ended.
    public override int Read(byte[] buffer, int offset, int count) {
        int total = 0;
        while (total < count) { int n = src.Read(buffer, offset + total, count - total); if (n <= 0) { Ended = true; break; } total += n; }
        pos += total; return total;
    }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}
"@
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $stdin = New-Object CertiFriedPipeAudio([Console]::OpenStandardInput())
    $engine.SetInputToAudioStream($stdin, $format)
    Send @{ type = 'ready'; culture = $info.Culture.Name; phrases = $phrases.Count }

    while (-not $stdin.Ended) {
        try { $result = $engine.Recognize() } catch { if ($stdin.Ended) { break } else { throw } }
        if ($result) { Send @{ type = 'recognized'; text = $result.Text; confidence = [math]::Round($result.Confidence, 3) } }
    }
    Send @{ type = 'stopped' }
} catch {
    Send @{ type = 'error'; message = $_.Exception.Message }
    exit 1
}
