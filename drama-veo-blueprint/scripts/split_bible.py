#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
split_bible.py — Sinh mot bible-seqX.json (subset self-contained) tu BIBLE MASTER + mot seq.

Trich dung cac node ma tap do dung (tu shot.uses): nhan vat, boi canh, trang phuc/vat dung,
camera, style. Voi moi costume duoc dung, TU DONG keo theo nhan vat goc (costume.for) de giu
day nhan vat -> trang phuc. Moi truong (prompt, code, short_desc, uses, for...) copy Y NGUYEN tu
master, nen dong bo tuyet doi — mien la khi TAO ANH anh tai dung cung reference image cho moi key.

Dong bo hinh anh = cung KEY + cung ANH da tao, KHONG phai cung prompt. Dung master lam nguon chan ly;
sua asset o master roi sinh lai cac bible-seqX de khong lech.

Dung:  python split_bible.py <bible-master.json> <seq.json> [-o bible-seqX.json]
       (mac dinh ghi ra bible-<ten seq>.json canh file seq)
"""
import argparse, json, os, sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bible")
    ap.add_argument("seq")
    ap.add_argument("-o", "--out")
    args = ap.parse_args()

    b = json.load(open(args.bible, encoding="utf-8"))
    d = json.load(open(args.seq, encoding="utf-8"))

    assets = {a["key"]: a for a in b.get("assets", []) if a.get("key")}
    wardrobe = {w["key"]: w for w in b.get("wardrobe", []) if w.get("key")}
    cameras = {c["key"]: c for c in b.get("cameras", []) if c.get("key")}
    styles = {s["key"]: s for s in b.get("styles", []) if s.get("key")}

    used = set()
    for sh in d.get("shots", []):
        for u in (sh.get("uses") or []):
            used.add(u)

    # Voi moi costume duoc dung -> keo theo nhan vat goc (de giu day nhan vat->trang phuc)
    for k in list(used):
        w = wardrobe.get(k)
        if w and w.get("kind") in ("costume", "worn"):
            forc = w.get("for") or (w.get("uses") or [None])[0]
            if forc:
                used.add(forc)
            wears = w.get("wears")
            if wears:
                used.add(wears)
    # Voi moi GOC PHAN CANH duoc dung -> keo theo boi canh chinh (de giu day boi canh -> goc)
    for k in list(used):
        a = assets.get(k)
        if a and a.get("role") == "scene" and a.get("kind") == "angle":
            mof = a.get("of") or (a.get("uses") or [None])[0]
            if mof:
                used.add(mof)

    sub_assets = [assets[k] for k in assets if k in used]
    sub_wardrobe = [wardrobe[k] for k in wardrobe if k in used]
    sub_cameras = [cameras[k] for k in cameras if k in used]
    sub_styles = [styles[k] for k in styles if k in used]

    out = {}
    if "film" in b:
        out["film"] = b["film"]
    out["styles"] = sub_styles
    out["assets"] = sub_assets
    out["wardrobe"] = sub_wardrobe
    out["cameras"] = sub_cameras

    outpath = args.out
    if not outpath:
        stem = os.path.splitext(os.path.basename(args.seq))[0]
        outpath = os.path.join(os.path.dirname(args.seq) or ".", "bible-" + stem + ".json")
    json.dump(out, open(outpath, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    # canh bao key la (dung nhung khong co trong master)
    known = set(assets) | set(wardrobe) | set(cameras) | set(styles)
    missing = sorted(u for u in used if u not in known)
    print(f"{outpath}: {len(sub_assets)} asset, {len(sub_wardrobe)} wardrobe, "
          f"{len(sub_cameras)} camera, {len(sub_styles)} style"
          + (f" | THIEU trong master: {missing}" if missing else ""))


if __name__ == "__main__":
    main()
