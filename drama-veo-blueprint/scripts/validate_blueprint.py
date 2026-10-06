#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate_blueprint.py — Kiem tra blueprint drama VEO truoc khi giao.

MO HINH NODE (de cong cu node ve day tu 1 cong IN):
  - assets: NHAN VAT goc (role character, khoa MAT, xuyen suot) + BOI CANH (role scene).
  - wardrobe: nhom "Trang phuc - Vat dung" — costume (kind costume, co 'for' tro nhan vat goc)
    va vat dung/dao cu (kind item).
  - cameras, styles: node may quay / style co key.
  Moi shot liet ke MOI node no noi toi trong `uses`:
    nhan vat goc + costume (look dung boi canh) + boi canh + vat dung + 1 camera + 1 style.
  "Nhan vat moi giu mat" = nhan vat goc + costume cung co mat trong uses (cong cu ghep).

Kiem:
  - So ANH/shot <= gioi han (mac dinh 10): ANH = character + scene + moi node wardrobe
    (costume + item). camera, style KHONG tinh.
  - DU anh: @key (character/scene/item) trong videoPrompt/blocking deu nam trong uses.
  - Moi key trong uses ton tai (asset/wardrobe/camera/style). Khong co key la.
  - Moi shot co dung 1 camera + 1 style trong uses.
  - Moi NHAN VAT trong uses deu gan 1 COSTUME (co costume 'for' nhan vat do trong uses).
  - scalar camera/style khop key trong uses.
  - Timeline lien tuc; nhip; emotional khong phang; nhan vat du voice/expression.
  - Bible-first: canh bao neu seq khai node LOCAL thay vi bo vao bible.
  - CUM DOI THOAI (shot co `setups`): 2-3 co canh khac nhau (ots_a/ots_b/two_shot), `sides` tro 2 nguoi
    trong uses, nguoi noi cua ots_a o ben PHAI / ots_b o ben TRAI, moi cau co ten nguoi noi la mot trong hai,
    <= 3 tu/giay theo cach tool chia 8 giay, nhan vat co code + identity_label (+ back_view), boi canh co
    conversation (place, left/right background+light, anchor + two_shot khi co trung doi).

Dung: python validate_blueprint.py seq-01.json --bible bible.json
"""
import argparse, glob, json, re, sys
from collections import defaultdict, Counter

AT_KEY = re.compile(r"@([A-Za-z0-9_]+)")
VALID_BEATS = ["setup", "tension_rising", "confrontation", "reveal", "aftermath"]


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def collect(data):
    """-> img, cam, sty, aud(set), chars(dict), costume_for(dict key->for), codes, scenes(dict), wardrobe(dict)."""
    img, cam, sty, aud, chars, cfor, ccode = set(), set(), set(), set(), {}, {}, {}
    scenes, wards = {}, {}
    for a in data.get("assets", []) or []:
        k = a.get("key")
        if not k:
            continue
        if a.get("role") in ("character", "scene", "prop"):
            img.add(k)
        if a.get("role") == "character":
            chars[k] = a
            if a.get("code"):
                ccode[k] = a["code"]
        if a.get("role") == "scene":
            scenes[k] = a
    for w in data.get("wardrobe", []) or []:
        k = w.get("key")
        if not k:
            continue
        img.add(k)
        wards[k] = w
        if w.get("kind") in ("costume", "worn") and w.get("for"):
            cfor[k] = w["for"]
    for c in data.get("cameras", []) or []:
        if c.get("key"):
            cam.add(c["key"])
    for s in data.get("styles", []) or []:
        if s.get("key"):
            sty.add(s["key"])
    for a in data.get("audio", []) or []:
        if a.get("key"):
            aud.add(a["key"])
    return img, cam, sty, aud, chars, cfor, ccode, scenes, wards


FRAMINGS = ("ots_a", "ots_b", "two_shot")
WORDS_PER_SECOND = 3
CLIP_SECONDS = 8


def short_name(name):
    """'Eleanor Ashford — quan gia' -> 'eleanor ashford' (what the tool matches a 'Name:' prefix against)."""
    return re.split(r"\s*[—–(\-]\s*", str(name or ""), 1)[0].strip().lower()


def speaker_key(dialogue, people, chars):
    """The character key (one of `people`) a 'Name: "..."' line names, by name or by code; else None."""
    m = re.match(r'\s*([^:"\[\]]+?)\s*:', str(dialogue or ""))
    if not m:
        return None
    spoken = re.sub(r"\(.*?\)", "", m.group(1)).strip().lower()
    if not spoken:
        return None
    for k in people:
        a = chars.get(k) or {}
        nm = short_name(a.get("name"))
        if (nm and (nm.startswith(spoken) or spoken.startswith(nm.split(" ")[0]))) or spoken == str(a.get("code") or "").lower():
            return k
    return None


def line_words(dialogue):
    t = re.sub(r'^\s*[^:"\[\]]+:\s*', "", str(dialogue or "")).strip()
    t = re.sub(r'^["\u201c](.*)["\u201d]$', r"\1", t, flags=re.S).strip()
    return len(t.split())


def split_seconds(counts):
    """How the tool shares the 8 s: two setups 4/4, three by word count, never under 2 s."""
    n = len(counts)
    if n == 2:
        return [4, 4]
    total = sum(counts)
    secs = [max(2, round(CLIP_SECONDS * c / total)) if total else CLIP_SECONDS // n for c in counts]
    while sum(secs) > CLIP_SECONDS:
        i = max((i for i in range(n) if secs[i] > 2), key=lambda i: secs[i], default=None)
        if i is None:
            break
        secs[i] -= 1
    while sum(secs) < CLIP_SECONDS:
        secs[max(range(n), key=lambda i: secs[i])] += 1
    return secs


def validate_cluster(tag, s, uses, chars, cfor, scenes, wards, errors, warnings):
    """A shot with `setups`: 2-3 camera setups of one exchange, filmed as ONE Veo clip."""
    setups = s.get("setups") or []
    if not isinstance(setups, list) or len(setups) < 2:
        errors.append(f"[{tag}] 'setups' can 2-3 co canh (co {len(setups) if isinstance(setups, list) else '?'}).")
        return
    if len(setups) > 3:
        errors.append(f"[{tag}] 'setups' co {len(setups)} co canh — Veo nhan toi da 3 anh.")
    if s.get("camera"):
        warnings.append(f"[{tag}] cum doi thoai khong dung 'camera' (co canh nam trong setups) — bo di.")
    if str(s.get("videoPrompt") or "").strip():
        warnings.append(f"[{tag}] cum doi thoai khong dung 'videoPrompt' (tool tu dung prompt cat canh) — bo di.")
    if s.get("duration") not in (None, 8):
        warnings.append(f"[{tag}] cum doi thoai luon quay 8 giay (duration={s.get('duration')}).")
    # the two people: character keys, through a costume when the shot dresses them
    people, node_for = [], {}
    for u in uses:
        c = cfor.get(u) if u in cfor else (u if u in chars else None)
        if not c:
            continue
        if c not in people:
            people.append(c)
        if u in cfor or c not in node_for:
            node_for[c] = u
    if len(people) != 2:
        errors.append(f"[{tag}] cum doi thoai can dung 2 nguoi trong uses (co {len(people)}: {people}).")
    sides = s.get("sides") if isinstance(s.get("sides"), dict) else {}
    def side(v):
        k = str(v or "").strip()
        return cfor.get(k, k) if k else ""
    left, right = side(sides.get("left")), side(sides.get("right"))
    if not sides:
        warnings.append(f"[{tag}] thieu 'sides' — tool lay thu tu trong uses: trai={people[:1]}, phai={people[1:2]}.")
        left, right = (people + ["", ""])[:2]
    for lab, k in (("left", left), ("right", right)):
        if k and k not in people:
            errors.append(f"[{tag}] sides.{lab}='{k}' khong phai mot trong 2 nguoi trong uses.")
    if left and left == right:
        errors.append(f"[{tag}] sides trai va phai cung mot nguoi ({left}).")
    # the place: `place`, else the first scene in uses; an angle resolves to its master
    pk = str(s.get("place") or "").strip() or next((u for u in uses if u in scenes), "")
    seen = set()
    while pk in scenes and scenes[pk].get("of") and pk not in seen and not scenes[pk].get("conversation"):
        seen.add(pk)
        pk = scenes[pk]["of"]
    sc = scenes.get(pk)
    if not sc:
        errors.append(f"[{tag}] cum doi thoai khong co boi canh trong uses.")
    framings = [str(x.get("framing") or "") if isinstance(x, dict) else "" for x in setups]
    has_ots = any(f in ("ots_a", "ots_b") for f in framings)
    has_two = "two_shot" in framings
    if sc:
        conv = sc.get("conversation") if isinstance(sc.get("conversation"), dict) else {}
        if not conv:
            errors.append(f"[{tag}] boi canh '{pk}' thieu 'conversation' (place, left, right) — tool khong dung duoc anh khung.")
        else:
            if not str(conv.get("place") or "").strip():
                errors.append(f"[{tag}] boi canh '{pk}': conversation.place trong (cau mo cua anh khung, tieng Anh).")
            for sd in ("left", "right"):
                d = conv.get(sd) if isinstance(conv.get(sd), dict) else {}
                for f in ("background", "light"):
                    if not str(d.get(f) or "").strip():
                        errors.append(f"[{tag}] boi canh '{pk}': conversation.{sd}.{f} trong.")
                if has_two and not str(d.get("anchor") or "").strip():
                    errors.append(f"[{tag}] boi canh '{pk}': conversation.{sd}.anchor trong (can cho trung doi).")
            if has_two and not str(conv.get("two_shot") or "").strip():
                warnings.append(f"[{tag}] boi canh '{pk}': conversation.two_shot trong (may dung dau khi quay trung doi).")
    # the Bible fields the frame prompts need
    for k in people:
        a = chars.get(k) or {}
        if not str(a.get("code") or "").strip():
            errors.append(f"[{tag}] nhan vat '{k}' thieu 'code' (NV1, NV2...) — cum doi thoai goi nguoi bang ma.")
        if not str(a.get("identity_label") or "").strip():
            errors.append(f"[{tag}] nhan vat '{k}' thieu 'identity_label' (2-5 chu, tieng Anh).")
        w = wards.get(node_for.get(k, ""), {})
        if has_ots and not (str(a.get("back_view") or "").strip() or str(w.get("back_view") or "").strip()):
            errors.append(f"[{tag}] nhan vat '{k}' thieu 'back_view' (lung/toc sau/vai) — can cho khung qua vai.")
    # each setup
    counts = []
    for i, x in enumerate(setups):
        st = f"{tag} setup#{i + 1}"
        if not isinstance(x, dict):
            errors.append(f"[{st}] khong phai object."); counts.append(0); continue
        fr = framings[i]
        if fr not in FRAMINGS:
            errors.append(f"[{st}] framing '{fr}' khong hop le (ots_a, ots_b, two_shot).")
        elif framings.count(fr) > 1:
            errors.append(f"[{st}] co canh '{fr}' lap lai — moi cum moi co canh mot lan.")
        dlg = str(x.get("dialogue") or "").strip()
        counts.append(line_words(dlg))
        if not dlg or dlg.startswith("["):
            continue
        sp = speaker_key(dlg, people, chars)
        if not sp:
            errors.append(f"[{st}] cau thoai phai viet dang Ten: \"...\" voi ten cua {people} — tool khong biet ai noi.")
            continue
        if fr == "ots_a" and right and sp != right:
            errors.append(f"[{st}] ots_a: nguoi noi phai la nguoi ben PHAI ({right}), khong phai '{sp}'. Doi sang ots_b hoac doi sides.")
        if fr == "ots_b" and left and sp != left:
            errors.append(f"[{st}] ots_b: nguoi noi phai la nguoi ben TRAI ({left}), khong phai '{sp}'. Doi sang ots_a hoac doi sides.")
        if not str(x.get("audio_delivery") or "").strip():
            warnings.append(f"[{st}] thieu audio_delivery (cach noi, tieng Anh).")
    if 2 <= len(setups) <= 3:
        secs = split_seconds(counts)
        for i, (w, sec) in enumerate(zip(counts, secs)):
            if w > WORDS_PER_SECOND * sec:
                warnings.append(f"[{tag} setup#{i + 1}] {w} tu trong {sec} giay = {w / sec:.1f} tu/giay (nen <= {WORDS_PER_SECOND}) — rut ngan cau, Veo nuot chu.")
    if framings[:1] == ["two_shot"]:
        warnings.append(f"[{tag}] trung doi mo dau chua test — thu tu da test la A -> B (-> trung doi).")


def local_keys(data):
    ks = set()
    for a in data.get("assets", []) or []:
        if a.get("key"):
            ks.add(a["key"])
    for w in data.get("wardrobe", []) or []:
        if w.get("key"):
            ks.add(w["key"])
    for c in data.get("cameras", []) or []:
        if c.get("key"):
            ks.add(c["key"])
    for s in data.get("styles", []) or []:
        if s.get("key"):
            ks.add(s["key"])
    return ks


def ats_in(*texts):
    found = set()
    for t in texts:
        if isinstance(t, str):
            found.update(AT_KEY.findall(t))
    return found


def validate_file(path, B, max_refs, soft_refs, check_timeline, has_bible):
    errors, warnings = [], []
    data = load_json(path)
    img = B["img"] | set()
    cam = B["cam"] | set()
    sty = B["sty"] | set()
    aud = B.get("aud", set()) | set()
    chars = dict(B["chars"])
    cfor = dict(B["cfor"])
    ccode = dict(B.get("ccode", {}))

    scenes = dict(B.get("scenes", {}))
    wards = dict(B.get("wards", {}))

    limg, lcam, lsty, laud, lchars, lcfor, lccode, lscenes, lwards = collect(data)
    img |= limg; cam |= lcam; sty |= lsty; aud |= laud
    chars.update(lchars); cfor.update(lcfor); ccode.update(lccode)
    scenes.update(lscenes); wards.update(lwards)

    loc = local_keys(data)
    if has_bible and loc:
        warnings.append("Seq khai node LOCAL thay vi bo vao bible: " + ", ".join(sorted(loc))
                        + " — hay bo sung vao bible.json roi tro key.")

    proj = data.get("project", {})
    ref_limit = int(proj.get("reference_limit", max_refs))
    shots = data.get("shots", []) or []
    if not shots:
        errors.append("Khong co 'shots' nao.")

    for i, s in enumerate(shots):
        tag = s.get("name", f"shot#{i}")
        uses = s.get("uses", []) or []
        img_u = [u for u in uses if u in img]
        cam_u = [u for u in uses if u in cam]
        sty_u = [u for u in uses if u in sty]
        aud_u = [u for u in uses if u in aud]
        unknown = [u for u in uses if u not in img and u not in cam and u not in sty and u not in aud]
        cluster = bool(s.get("setups"))
        if cluster:
            validate_cluster(tag, s, uses, chars, cfor, scenes, wards, errors, warnings)
        # Am thanh: nhac nen + tieng hien truong cho shot nay
        if aud:
            if not aud_u:
                warnings.append(f"[{tag}] thieu preset am thanh trong uses — node Am thanh khong noi.")
            elif len(aud_u) > 1:
                warnings.append(f"[{tag}] {len(aud_u)} preset am thanh trong uses, nen 1.")
            if s.get("audio") and aud_u and s["audio"] not in aud_u:
                warnings.append(f"[{tag}] scalar audio khong khop uses.")
        # Canh im lang: tool se them "No spoken dialogue…" va doc audio_delivery lam tieng hien truong
        dlg = str(s.get("dialogue") or "").strip()
        if cluster:
            dlg = "x"  # the lines live in the setups
        if (not dlg or dlg.startswith("[")) and not str(s.get("audio_delivery") or "").strip():
            warnings.append(f"[{tag}] shot khong thoai nhung thieu audio_delivery (tieng hien truong, tieng Anh).")
        if (not dlg or dlg.startswith("[")) and re.search(r"\b(says?|whisper|voice-?over|narrat)", str(s.get("videoPrompt") or ""), re.I):
            warnings.append(f"[{tag}] shot khong thoai nhung videoPrompt con dong tu noi — bo di, tool da ghi 'no spoken dialogue'.")

        for u in unknown:
            errors.append(f"[{tag}] uses '{u}' khong co trong Bible.")
        if len(img_u) > ref_limit:
            errors.append(f"[{tag}] {len(img_u)} ANH VUOT tran {ref_limit}: {img_u}")
        elif len(img_u) > soft_refs:
            warnings.append(f"[{tag}] {len(img_u)} anh (>{soft_refs}) — can nhac tach shot.")
        dressed = {cfor[u] for u in uses if u in cfor}   # nhan vat da co costume trong shot
        codes_set = set(ccode.values())
        uses_codes = {ccode[u] for u in uses if u in ccode}
        uses_codes |= {ccode[cfor[u]] for u in uses if u in cfor and cfor[u] in ccode}
        for m in ats_in(s.get("videoPrompt"), s.get("blocking")):
            if m in codes_set:                     # ma NV (NV1, NV2...)
                if m not in uses_codes:
                    errors.append(f"[{tag}] @{m} duoc dien nhung THIEU look cua {m} trong uses.")
                continue
            if m not in img:
                continue
            if m in uses:
                continue
            if m in chars and m in dressed:
                continue
            if m in chars:
                errors.append(f"[{tag}] @{m} duoc dien nhung THIEU look trong uses (them costume for={m}).")
            else:
                errors.append(f"[{tag}] @{m} nhac trong prompt nhung THIEU trong uses.")

        # camera / style (a cluster carries its framings in setups, so no camera)
        if cam and not cluster:
            if len(cam_u) == 0:
                warnings.append(f"[{tag}] thieu camera trong uses — node May quay khong noi.")
            elif len(cam_u) > 1:
                warnings.append(f"[{tag}] {len(cam_u)} camera trong uses, nen 1.")
            if s.get("camera") and cam_u and s["camera"] not in cam_u:
                warnings.append(f"[{tag}] scalar camera khong khop uses.")
        if sty:
            if len(sty_u) == 0:
                warnings.append(f"[{tag}] thieu style trong uses — node Style khong noi.")
            if s.get("style") and sty_u and s["style"] not in sty_u:
                warnings.append(f"[{tag}] scalar style khong khop uses.")

        # Chong MAC LAN: moi nhan vat chi 1 costume trong canh; khong dua ca nhan vat goc + costume
        if cfor:
            fc = Counter(cfor[u] for u in uses if u in cfor)
            for ch, n in fc.items():
                if n > 1:
                    warnings.append(f"[{tag}] nhan vat '{ch}' co {n} trang phuc trong 1 canh — de mac lan, chi giu 1 costume.")
            for u in uses:
                if u in chars and u in fc:
                    warnings.append(f"[{tag}] '{u}' vua noi nhan vat goc vua noi costume vao canh — bo node goc, chi noi costume (nhan vat da vao qua 'for').")

        dur = 8 if cluster and s.get("duration") is None else s.get("duration")
        if not isinstance(dur, (int, float)) or dur <= 0:
            errors.append(f"[{tag}] duration khong hop le: {dur}")
        elif dur > 10:
            warnings.append(f"[{tag}] duration {dur}s > 10s.")
        if s.get("beat") and s["beat"] not in VALID_BEATS:
            warnings.append(f"[{tag}] beat '{s['beat']}' khong chuan.")

    used_chars = set()
    for s in shots:
        for u in (s.get("uses") or []):
            if u in chars:
                used_chars.add(u)
            if u in cfor:
                used_chars.add(cfor[u])
    for k in used_chars:
        c = chars[k]
        if not c.get("voice_profile"):
            warnings.append(f"[asset {k}] thieu voice_profile.")
        if not c.get("expression_matrix"):
            warnings.append(f"[asset {k}] thieu expression_matrix.")

    if check_timeline and shots:
        cur, gap = 0, False
        for s in shots:
            if s.get("start") != cur:
                gap = True
            cur += (8 if s.get("setups") and s.get("duration") is None else s.get("duration", 0)) or 0
        if gap:
            warnings.append("Timeline KHONG lien tuc.")
        dec = proj.get("duration_seconds")
        if dec is not None and dec != cur:
            warnings.append(f"Tong duration {cur}s != duration_seconds {dec}s.")
        evs = [s.get("emotional_value") for s in shots if isinstance(s.get("emotional_value"), (int, float))]
        if len(evs) >= 3 and len(set(evs)) == 1:
            warnings.append("Duong emotional_value PHANG.")
        agg = defaultdict(int)
        for s in shots:
            if s.get("beat") in VALID_BEATS:
                agg[s["beat"]] += s.get("duration", 0) or 0
        if agg and cur:
            print("   nhip: " + ", ".join(f"{bt}={agg[bt]/cur*100:.0f}%" for bt in VALID_BEATS if agg[bt]))

    return errors, warnings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--bible")
    ap.add_argument("--max-refs", type=int, default=10)
    ap.add_argument("--soft-refs", type=int, default=9)
    ap.add_argument("--no-timeline", action="store_true")
    ap.add_argument("--edges", action="store_true",
                    help="In ra toan bo DAY (edge) ma cong cu node phai ve, de doi chieu.")
    args = ap.parse_args()

    B = {"img": set(), "cam": set(), "sty": set(), "aud": set(), "chars": {}, "cfor": {}, "ccode": {}, "scenes": {}, "wards": {}}
    if args.bible:
        b = load_json(args.bible)
        im, ca, st, au, ch, cf, cc, scn, wd = collect(b)
        B = {"img": im, "cam": ca, "sty": st, "aud": au, "chars": ch, "cfor": cf, "ccode": cc, "scenes": scn, "wards": wd}
        print(f"Bible: {len(im)} anh (nhan vat+boi canh+trang phuc+vat dung), "
              f"{len(ca)} camera, {len(st)} style, {len(au)} preset am thanh, {len(cf)} costume co 'for' tu {args.bible}")
        if not au:
            print("   WARNING: BIBLE khong co 'audio' — them preset nhac nen/tieng hien truong (mục 4c) roi gan vao tung shot.")
        for w in b.get("wardrobe", []) or []:
            k = w.get("key"); kind = w.get("kind")
            if kind == "costume":
                # Mo hinh 2 node cua tool: costume = BO DO (khong input), chi ghi 'for' tro nhan vat;
                # tool tu dung node "NV da mac" tu for. Khong can (va khong nen) co 'uses'.
                if not w.get("for"):
                    print(f"   ⚠ BIBLE: costume '{k}' thieu \"for\" tro nhan vat — tool khong dung duoc node 'NV da mac'.")
                if w.get("uses"):
                    print(f"   ⚠ BIBLE: costume '{k}' co 'uses' — bo di, bo do khong nhan anh dau vao (chi dung 'for').")
            elif kind == "worn":
                u = w.get("uses") or []
                forc = w.get("for"); wears = w.get("wears")
                if forc and forc not in u:
                    print(f"   ⚠ BIBLE: node phoi '{k}' thieu input NHAN VAT trong 'uses' (them \"{forc}\").")
                if wears and wears not in u:
                    print(f"   ⚠ BIBLE: node phoi '{k}' thieu input BO DO trong 'uses' (them \"{wears}\").")
            elif kind == "outfit":
                if w.get("uses"):
                    print(f"   ⚠ BIBLE: bo do '{k}' KHONG duoc co input (uses phai rong) — no la node doc lap.")
        scene_keys = {a.get("key") for a in b.get("assets", []) if a.get("role") == "scene"}
        for a in b.get("assets", []) or []:
            if a.get("role") == "scene" and a.get("kind") == "angle":
                mof = a.get("of")
                u = a.get("uses") or []
                if not mof or mof not in u:
                    print(f"   ⚠ BIBLE: goc phan canh '{a.get('key')}' thieu input boi canh chinh trong 'uses' "
                          f"(them \"{mof}\") — se khong co day boi canh chinh -> goc.")
                elif mof not in scene_keys:
                    print(f"   ⚠ BIBLE: goc '{a.get('key')}' co of='{mof}' khong phai boi canh.")
        print()

    paths = []
    for pat in args.files:
        hit = glob.glob(pat)
        paths.extend(hit if hit else [pat])

    if args.edges:
        def kmap(data):
            m = {}
            for a in data.get("assets", []) or []:
                if a.get("key"): m[a["key"]] = a.get("role")        # character | scene
            for w in data.get("wardrobe", []) or []:
                if w.get("key"): m[w["key"]] = w.get("kind")        # costume | item
            for c in data.get("cameras", []) or []:
                if c.get("key"): m[c["key"]] = "camera"
            for s in data.get("styles", []) or []:
                if s.get("key"): m[s["key"]] = "style"
            return m
        base = {}
        bdata = None
        if args.bible:
            bdata = load_json(args.bible)
            base = kmap(bdata)
            print("=== DAY 1: nhan vat -> trang phuc (tu bible.wardrobe) ===")
            for w in bdata.get("wardrobe", []) or []:
                if w.get("kind") == "costume":
                    src = (w.get("uses") or [w.get("for")])[0]
                    print(f"   {src}  ->  {w['key']}")
            print()
        for p in paths:
            d = load_json(p)
            km = dict(base); km.update(kmap(d))
            print(f"=== DAY 2: cac node -> shot  ({p}) ===")
            for s in d.get("shots", []) or []:
                for u in (s.get("uses") or []):
                    print(f"   {u}  ->  [{s.get('name')}]   ({km.get(u,'?')})")
            print()
        return

    total_err = 0
    for p in paths:
        print(f"=== {p} ===")
        try:
            errs, warns = validate_file(p, B, args.max_refs, args.soft_refs,
                                        not args.no_timeline, bool(args.bible))
        except Exception as e:
            print(f"   ERROR doc file: {e}\n"); total_err += 1; continue
        for w in warns:
            print(f"   WARNING: {w}")
        for e in errs:
            print(f"   ERROR:   {e}")
        if not errs:
            print(f"   PASS — khong co loi chan ({len(warns)} canh bao).")
        total_err += len(errs)
        print()

    if total_err:
        print(f"KET QUA: {total_err} ERROR — can sua."); sys.exit(1)
    print("KET QUA: TAT CA PASS (co the con WARNING)."); sys.exit(0)


if __name__ == "__main__":
    main()
