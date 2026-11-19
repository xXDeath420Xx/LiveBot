<# Test helper: speak a phrase with a built-in Windows voice into a 16 kHz 16-bit mono WAV file (no microphone). #>
param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][string]$Out)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($Out, $fmt)
$s.Speak($Text)
$s.Dispose()
