"""Forced alignment of a song's lyric lines to its isolated vocal (Drama Tool lip-sync).

Usage: python align_lyrics.py <vocals.wav> <lines.json> <out.json> [lang] [device]
  lines.json: [{"id": "...", "text": "..."}] in the order they are sung (every sung line of the
  song, so each one lands in its own place); lang: "es" (default) or "en".
  out.json:  {"model": ..., "seconds": ..., "lines": [{"id", "start", "end", "score"}]}
             start/end in seconds of the song; score = mean per-character confidence (0–1).

A wav2vec2 CTC speech model emits per-20 ms character probabilities over the vocal; CTC forced
alignment then places the known text — every character, in order — on the frames that fit it
best, so each line gets the time it is really sung, wherever the storyboard had put it.
"""
import json
import sys
import unicodedata

import soundfile as sf
import torch
import torchaudio

PIPES = {
    "es": torchaudio.pipelines.VOXPOPULI_ASR_BASE_10K_ES,
    "en": torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H,
}


def main():
    vocals, lines_path, out_path = sys.argv[1:4]
    lang = sys.argv[4] if len(sys.argv) > 4 else "es"
    bundle = PIPES.get(lang, PIPES["es"])
    with open(lines_path, encoding="utf-8") as f:
        lines = json.load(f)
    device = sys.argv[5] if len(sys.argv) > 5 else ("cuda" if torch.cuda.is_available() else "cpu")
    model = bundle.get_model().to(device).eval()
    labels = bundle.get_labels()
    index = {c: i for i, c in enumerate(labels)}
    upper = not "".join(labels[1:]).islower()  # the English model's alphabet is upper case

    def char_ok(c):
        # a letter of the model's alphabet — not its CTC blank (labels[0], "-") nor the word
        # separator "|": either one in the transcript makes forced_align fail for the whole song
        k = c.upper() if upper else c
        return k in index and index[k] != 0 and k != "|"

    def norm(text):
        out = []
        for c in text.lower():
            if char_ok(c):
                out.append(c)
                continue
            base = unicodedata.normalize("NFD", c)[0]  # à → a when the model has no à
            out.append(base if char_ok(base) else " ")
        return [w for w in "".join(out).split() if w]

    audio, sr = sf.read(vocals, dtype="float32", always_2d=True)
    wav = torchaudio.functional.resample(torch.from_numpy(audio.mean(axis=1)), sr, bundle.sample_rate)
    # Emissions in 20 s pieces (a whole song in one pass does not fit attention in memory).
    step = bundle.sample_rate * 20
    pieces = []
    with torch.inference_mode():
        for i in range(0, wav.numel(), step):
            x = wav[i : i + step]
            if x.numel() < bundle.sample_rate // 10:
                break
            em, _ = model(x[None].to(device))
            pieces.append(torch.log_softmax(em, dim=-1)[0].float().cpu())
    emission = torch.cat(pieces)
    sec_per_frame = wav.numel() / bundle.sample_rate / emission.shape[0]

    # The transcript: every line's words joined by the word separator "|"; remember which
    # target tokens belong to which line (separators belong to none).
    sep = index.get("|")
    targets, owner = [], []
    for li, line in enumerate(lines):
        words = norm(line.get("text", ""))
        for w in words:
            if targets and sep is not None:
                targets.append(sep)
                owner.append(-1)
            for c in w:
                targets.append(index[c.upper() if upper else c])
                owner.append(li)
    if not targets:
        raise SystemExit("no alignable text")
    if len(targets) >= emission.shape[0]:
        raise SystemExit("lyrics longer than the audio can hold")
    ali, scores = torchaudio.functional.forced_align(
        emission[None], torch.tensor([targets], dtype=torch.int32), blank=0
    )
    spans = torchaudio.functional.merge_tokens(ali[0], scores[0].exp())
    result = []
    for li, line in enumerate(lines):
        mine = [s for s, o in zip(spans, owner) if o == li]
        if not mine:
            result.append({"id": line.get("id"), "start": None, "end": None, "score": 0})
            continue
        result.append(
            {
                "id": line.get("id"),
                "start": round(mine[0].start * sec_per_frame, 3),
                "end": round(mine[-1].end * sec_per_frame, 3),
                "score": round(sum(s.score for s in mine) / len(mine), 3),
            }
        )
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(
            {"model": "wav2vec2-" + lang, "device": device, "seconds": round(wav.numel() / bundle.sample_rate, 3), "lines": result},
            f,
            ensure_ascii=False,
        )


if __name__ == "__main__":
    main()
