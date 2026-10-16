$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$items = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'content.json') -Raw | ConvertFrom-Json
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice.SelectVoice('Microsoft Zira Desktop')
$voice.Rate = 1
for ($i = 0; $i -lt $items.Count; $i++) {
    $voice.SetOutputToWaveFile((Join-Path $PSScriptRoot "voice-$i.wav"))
    $voice.Speak($items[$i].narration)
    $voice.SetOutputToNull()
}
$voice.Dispose()
