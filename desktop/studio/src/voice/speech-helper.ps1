<#
  CertiFried Studio voice helper. Offline phrase recognition with Windows' built-in desktop speech recognizer
  (System.Speech, part of .NET Framework on every Windows 10/11; no install, no internet).

  Input:  raw audio on stdin, 16 kHz, 16-bit, mono PCM, sent by CertiFried Studio from the microphone the person
          picked. Nothing is saved; the audio only passes through this process's memory.
  Grammars (0.2.10): "commands", the phrases in -GrammarFile (a JSON array of strings), and a catch-all: a wildcard
          "garbage" grammar, or Windows' free dictation while Studio's "log all speech" is on. Without the catch-all, any
          speech was forced onto the nearest command phrase (BRB fired five times in ten minutes at 0.2). Now ordinary talk is won
          by the catch-all and Studio only acts on results from "commands". -CatchAll garbage|dictation|none (below).
  Output: one JSON object per line on stdout:
          {"type":"ready","culture":"en-US","catchAll":"garbage"} |
          {"type":"recognized","text":"...","confidence":0.93,"grammar":"commands"|"dictation"|"garbage"} |
          {"type":"stopped"} | {"type":"error","message":"..."}
  Ends when stdin closes (Studio stopped listening).
#>
param(
    [Parameter(Mandatory = $true)][string]$GrammarFile,
    [string]$Culture = '',
    [ValidateSet('garbage', 'dictation', 'none')][string]$CatchAll = 'garbage'
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
    $commands = New-Object System.Speech.Recognition.Grammar($builder)
    $commands.Name = 'commands'
    $commands.Priority = 10
    $engine.LoadGrammar($commands)
    # The catch-all, so speech that is not a command has somewhere to go instead of being forced onto the nearest phrase.
    #   garbage    (default) one wildcard: absorbs any speech, gives no words. Measured with Windows' own voice reading
    #              the owner's kind of phrases (test/voice.test.js): every command still recognised, ordinary sentences
    #              ("what a lovely day", "check the pokemon") went to the catch-all instead of a command.
    #   dictation  Windows' free dictation: gives the words (Studio's "log all speech"), but in the same measurement it
    #              also took some real commands, so it is only used while that log option is on.
    #   none       the old behaviour (tests).
    # Its results are never acted on: Studio only fires on results from "commands".
    $loaded = 'none'
    if ($CatchAll -eq 'dictation') {
        try {
            $dict = New-Object System.Speech.Recognition.DictationGrammar
            $dict.Name = 'dictation'
            $engine.LoadGrammar($dict)
            $loaded = 'dictation'
        } catch { $loaded = 'none' }
    }
    if ($CatchAll -ne 'none' -and $loaded -eq 'none') {
        try {
            $wb = New-Object System.Speech.Recognition.GrammarBuilder
            $wb.Culture = $info.Culture
            $wb.AppendWildcard()
            $garbage = New-Object System.Speech.Recognition.Grammar($wb)
            $garbage.Name = 'garbage'
            $engine.LoadGrammar($garbage)
            $loaded = 'garbage'
        } catch { $loaded = 'none' }
    }
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
    Send @{ type = 'ready'; culture = $info.Culture.Name; phrases = $phrases.Count; catchAll = $loaded }

    while (-not $stdin.Ended) {
        try { $result = $engine.Recognize() } catch { if ($stdin.Ended) { break } else { throw } }
        if ($result) {
            $gname = if ($result.Grammar -and $result.Grammar.Name) { [string]$result.Grammar.Name } else { 'unknown' }
            Send @{ type = 'recognized'; text = $result.Text; confidence = [math]::Round($result.Confidence, 3); grammar = $gname }
        }
    }
    Send @{ type = 'stopped' }
} catch {
    Send @{ type = 'error'; message = $_.Exception.Message }
    exit 1
}
