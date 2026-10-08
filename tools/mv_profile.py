#!/usr/bin/env python3
"""
mv_profile.py — Hồ sơ âm nhạc cho MV shot list (chạy TRƯỚC khi gọi LLM).

  python mv_profile.py song.(mp3|wav) out.json [--lyric lyric.txt] [--device cuda|cpu]
                       [--vocals-out vocals.wav] [--model htdemucs_6s]

Tách 6 stem bằng Demucs, đo độ to từng stem → nhận NHẠC CỤ có mặt (Guitarist / Pianist /
Drummer / Bassist), đo đường độ to cả bài → ENERGY theo thời gian, ước lượng NHỊP BÀI từ mật độ
lời. KHÔNG cần laion-clap: chỉ dùng demucs + torchaudio + numpy (đã có sẵn cùng demucs / align).

Ghi JSON ra `out.json`:
  { ok, instruments:[...], feel:"cham"|"nhanh", words_per_sec, total, lo_db, hi_db,
    energy_curve:[[t, db], ...], vocals }
"""
import sys, json, argparse, subprocess, tempfile, shutil, re
from pathlib import Path
import numpy as np

STEM_ROLE = {"guitar": "Guitarist", "piano": "Pianist", "drums": "Drummer", "bass": "Bassist"}


def find(dir_, name):
    for p in Path(dir_).rglob(name):
        return p
    return None


def load_mono(path, sr=22050):
    """Mono waveform at sr, via torchaudio (no librosa)."""
    import torchaudio

    wav, in_sr = torchaudio.load(str(path))
    if wav.shape[0] > 1:
        wav = wav.mean(0, keepdim=True)
    if in_sr != sr:
        wav = torchaudio.functional.resample(wav, in_sr, sr)
    return wav.squeeze(0).numpy(), sr


def rms_db(y, sr, win=2048, hop=512):
    y = np.ascontiguousarray(y, dtype=np.float32)
    if len(y) < win:  # shorter than one window: one frame over the whole (padded) signal
        y = np.pad(y, (0, win - len(y)))
    n = 1 + (len(y) - win) // hop
    frames = np.lib.stride_tricks.as_strided(
        y, shape=(n, win), strides=(y.strides[0] * hop, y.strides[0])
    )
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(1) + 1e-12)
    db = 20 * np.log10(rms + 1e-9)
    t = np.arange(n) * hop / sr
    return t, db


def separate(song, out_dir, model, device):
    args = [sys.executable, "-m", "demucs", "-n", model]
    if device:
        args += ["-d", device]
    args += ["-o", str(out_dir), str(song)]
    subprocess.run(args, check=True)
    d = Path(out_dir) / model / Path(song).stem
    return {p.stem: p for p in d.glob("*.wav")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("song")
    ap.add_argument("out")
    ap.add_argument("--lyric")
    ap.add_argument("--device", default=None)
    ap.add_argument("--vocals-out")
    ap.add_argument("--model", default="htdemucs_6s")
    a = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="mv-profile-"))
    try:
        stems = separate(a.song, tmp, a.model, a.device)
        # per-stem loudness: 90th-percentile dB and the share of time it is within 30 dB of the
        # loudest stem (= "audible / playing")
        stats, peak = {}, -120.0
        for name, p in stems.items():
            y, sr = load_mono(p)
            _, db = rms_db(y, sr)
            p90 = float(np.percentile(db, 90))
            stats[name] = {"p90": p90, "db": db}
            peak = max(peak, p90)
        instruments = []
        cands = []
        for stem, role in STEM_ROLE.items():
            s = stats.get(stem)
            if not s:
                continue
            active = float(np.mean(s["db"] > peak - 30))
            rel = s["p90"] - peak
            if active >= 0.25 and rel >= -18:
                cands.append((active + (rel + 18) / 18, role, stem))
        cands.sort(reverse=True)
        melodic = [c for c in cands if c[2] in ("guitar", "piano")]
        rhythm = [c for c in cands if c[2] in ("drums", "bass")]
        instruments = [c[1] for c in (melodic + rhythm)[:3]]

        # the energy curve over the whole song (dB per ~2 s), from the full mix
        ysong, sr = load_mono(a.song)
        total = round(len(ysong) / sr, 3)
        t, db = rms_db(ysong, sr)
        curve = []
        for s0 in np.arange(0, max(total, 0.1), 2.0):
            m = (t >= s0) & (t < s0 + 2.0)
            if m.any():
                curve.append([round(float(s0), 2), round(float(db[m].mean()), 1)])
        allsong = db
        lo = float(np.percentile(allsong, 5))
        hi = float(np.percentile(allsong, 95))

        # feel: slow when words are sparse on the vocal (ballad/worship read slow)
        wps = None
        vp = stems.get("vocals")
        if a.lyric and vp:
            yv, svr = load_mono(vp)
            _, vdb = rms_db(yv, svr)
            voiced_sec = float(np.mean(vdb > vdb.max() - 24) * len(yv) / svr)
            words = len(re.sub(r"\[.*?\]", "", Path(a.lyric).read_text(encoding="utf-8")).split())
            wps = round(words / max(voiced_sec, 1.0), 2)
        feel = "cham" if (wps is None or wps < 2.0) else "nhanh"

        vocals = None
        if a.vocals_out and vp:
            shutil.copyfile(vp, a.vocals_out)
            vocals = a.vocals_out

        profile = {
            "ok": True,
            "instruments": instruments,
            "feel": feel,
            "words_per_sec": wps,
            "total": total,
            "lo_db": round(lo, 1),
            "hi_db": round(hi, 1),
            "energy_curve": curve,
            "vocals": vocals,
        }
        Path(a.out).write_text(json.dumps(profile, ensure_ascii=False), encoding="utf-8")
        print("OK " + a.out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
