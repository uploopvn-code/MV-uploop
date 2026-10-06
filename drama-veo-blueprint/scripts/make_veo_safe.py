#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_veo_safe.py — Tu gan nhan an toan VEO cho MOI shot cua mot seq (gom ca phan canh phu):
  1) Doi @<ten nhan vat> -> @NV (ma dinh danh trung tinh) trong videoPrompt/blocking/axis_180.
  2) XOA cau gioi thieu ngoai hinh "In this shot, NV1 is a <mo ta>..." trong videoPrompt: anh tham
     chieu da la dien mao, ta lai chi choi voi anh (tool node-graph tu ghep dong anh xa anh <-> ma).
  3) Them duoi nhan hu cau: "no text, no artifacts." -> "..., fictional characters only, no resemblance
     to any real person or celebrity." (hoac them vao cuoi neu chua co duoi do).

Khong doi thoi luong/start. Chay xong nen validate lai bang validate_blueprint.py.

Dung:  python make_veo_safe.py <seq.json> --bible <bible.json>
"""
import argparse, json, re, sys

FIC_TAIL = "fictional characters only, no resemblance to any real person or celebrity"
OLD = "no text, no artifacts."
NEW = "no text, no artifacts, " + FIC_TAIL + "."
OPEN = "Compose connected reference subjects seamlessly."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("seq")
    ap.add_argument("--bible", required=True)
    args = ap.parse_args()

    b = json.load(open(args.bible, encoding="utf-8"))
    code = {a["key"]: a["code"] for a in b.get("assets", []) if a.get("role") == "character" and a.get("code")}
    desc = {a["code"]: a.get("short_desc", "") for a in b.get("assets", []) if a.get("role") == "character" and a.get("code")}
    cfor = {w["key"]: w["for"] for w in b.get("wardrobe", []) if w.get("kind") == "costume" and w.get("for")}

    d = json.load(open(args.seq, encoding="utf-8"))
    n_tail = n_nv = n_cast = 0

    def codes_present(uses):
        pc = {}
        for u in uses:
            ch = u if u in code else (cfor.get(u))
            if ch and ch in code:
                pc[code[ch]] = desc.get(code[ch], "")
        return pc

    for sh in d.get("shots", []):
        # Cum doi thoai (setups): tool tu dung prompt cat canh, khong co videoPrompt de gan nhan.
        if sh.get("setups"):
            continue
        vp = sh.get("videoPrompt", "")
        # 1) duoi nhan hu cau
        if FIC_TAIL not in vp:
            if OLD in vp:
                vp = vp.replace(OLD, NEW); n_tail += 1
            elif vp.rstrip().endswith("."):
                vp = vp.rstrip()[:-1] + ", " + FIC_TAIL + "."; n_tail += 1
            else:
                vp = vp.rstrip() + ". " + FIC_TAIL + "."; n_tail += 1
        sh["videoPrompt"] = vp
        # 2) @ten -> @NV (videoPrompt, blocking, axis_180)
        for fld in ("videoPrompt", "blocking", "axis_180"):
            s = sh.get(fld)
            if isinstance(s, str):
                before = s
                for ch, c in code.items():
                    s = re.sub(r"@" + re.escape(ch) + r"\b", "@" + c, s)
                if s != before:
                    n_nv += 1
                sh[fld] = s
        # 3) bo cau gioi thieu ngoai hinh (giu cau dinh vi "NV1 is standing by the window")
        before = sh.get("videoPrompt", "")
        s = re.sub(r"\bIn this shot,\s+@?[A-Za-z0-9_]+\s+is\s+an?\s+[^.]*\.\s*", "", before, flags=re.I)
        if s != before:
            sh["videoPrompt"] = s.strip()
            n_cast += 1

    json.dump(d, open(args.seq, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"{args.seq}: +duoi hu cau {n_tail}, doi @NV {n_nv} truong, bo cast desc {n_cast} shot. "
          f"Hay chay validate_blueprint.py de kiem lai.")


if __name__ == "__main__":
    main()
