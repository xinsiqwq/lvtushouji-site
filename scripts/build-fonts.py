"""Build self-hosted static WOFF2 font subsets into public/fonts/.

Usage:
  uv run --with fonttools==4.66.1 --with brotli python scripts/build-fonts.py
"""
from __future__ import annotations

import copy
import os
import re
import shutil
import urllib.request
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / ".cache" / "fonts"
OUT_DIR = ROOT / "public" / "fonts"

FONT_SRC_DIR = Path(os.environ.get("FONT_SRC_DIR", str(CACHE_DIR)))
SANS_SOURCE = Path(os.environ.get("NOTO_SANS_SC_TTF", str(FONT_SRC_DIR / "NotoSansSC.original.ttf")))
OFL_SOURCE = Path(os.environ.get("NOTO_OFL_TXT", str(FONT_SRC_DIR / "NotoSansSC-OFL.txt")))
CATALOG_JS = ROOT / "public" / "stellarium" / "catalog.js"

FONT_URLS = {
    "Inter[opsz,wght].ttf": [
        "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf",
        "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf",
    ],
    "JetBrainsMono[wght].ttf": [
        "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf",
        "https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf",
    ],
    "NotoSerifSC[wght].ttf": [
        "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf",
        "https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf",
    ],
}

CORE_UI_COPY = """
旅途手记 把走过的山海，和看过的夜空收进一册。
个人门面 旅图 观星台 密匣 实验馆 整理台
首页 实时星图 文件密匣 实验室 后台 管理
切换至浅色模式 切换至深色模式 当前 跟随系统 浅色 深色 固定
沿途回放 暂停 继续 回望此地当夜星空 查看当夜星空
输入六位提取口令 校验 提取 下载 剩余次数 过期时间 附言 二维码
这一页暂时没能顺利打开 可以刷新重试 或先回到首页看看别的记录 重试 返回首页 页面走丢了 回到首页
光圈 快门 焦段 感光度 经度 纬度 海拔 拍摄时间 未定位 待定位 公开 私密
年月日时分秒东西南北零一二三四五六七八九十百千万
"""


def ensure_cached_font(filename: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = CACHE_DIR / filename
    if target.exists() and target.stat().st_size > 10_000:
        print(f"Using cached {filename} ({target.stat().st_size / 1024:.1f} KB)", flush=True)
        return target
    tmp = CACHE_DIR / f"{filename}.part"
    last_err: Exception | None = None
    for url in FONT_URLS[filename]:
        try:
            print(f"Downloading {filename} from {url} ...", flush=True)
            req = urllib.request.Request(url, headers={"User-Agent": "lvtushouji-font-builder/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp, tmp.open("wb") as out:
                while True:
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            tmp.replace(target)
            print(f"Downloaded {filename} ({target.stat().st_size / 1024:.1f} KB)", flush=True)
            return target
        except Exception as exc:
            last_err = exc
            tmp.unlink(missing_ok=True)
    raise RuntimeError(f"Failed to download {filename}: {last_err}")


def format_unicode_range(codepoints: set[int]) -> str:
    if not codepoints:
        return ""
    sorted_cps = sorted(codepoints)
    ranges: list[str] = []
    start = prev = sorted_cps[0]
    for cp in sorted_cps[1:]:
        if cp == prev + 1:
            prev = cp
        else:
            ranges.append(f"U+{start:04X}" if start == prev else f"U+{start:04X}-{prev:04X}")
            start = prev = cp
    ranges.append(f"U+{start:04X}" if start == prev else f"U+{start:04X}-{prev:04X}")
    return ", ".join(ranges)


def make_options() -> subset.Options:
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.hinting = False
    opts.recalc_timestamp = False
    opts.layout_features = ["*"]
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    return opts


def collect_core_cjk() -> set[int]:
    texts = [CORE_UI_COPY]
    for path in [ROOT / "PROJECT_BLUEPRINT.md", ROOT / "EXPANSION_BLUEPRINT.md", CATALOG_JS]:
        if path.exists():
            texts.append(path.read_text(encoding="utf-8", errors="ignore"))
    joined = "".join(texts)
    return {ord(ch) for ch in joined if 0x4E00 <= ord(ch) <= 0x9FFF}


def base_non_cjk_points() -> set[int]:
    pts = set(range(0x0020, 0x007F))
    pts |= set(range(0x00A0, 0x0100))
    pts |= set(range(0x2000, 0x2070))
    pts |= set(range(0x2190, 0x21A0))
    pts |= set(range(0x3000, 0x3040))
    pts |= set(range(0xFF00, 0xFFF0))
    pts |= set(map(ord, "°′″×÷±≈≠≤≥•·—…€£¥©®™"))
    return pts


def instantiate_static(source_font: TTFont, axes: dict[str, float]) -> TTFont:
    return instantiateVariableFont(
        source_font, axes, inplace=False, updateFontNames=True
    )


def subset_to_woff2(
    static_font: TTFont,
    codepoints: set[int],
    dest: Path,
    verify_tnum: bool = False,
) -> set[int]:
    font = copy.deepcopy(static_font)
    opts = make_options()
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=codepoints)
    sub.subset(font)

    if verify_tnum:
        gsub = font.get("GSUB")
        tags = (
            {rec.FeatureTag for rec in gsub.table.FeatureList.FeatureRecord}
            if gsub and gsub.table.FeatureList
            else set()
        )
        if "tnum" not in tags:
            raise RuntimeError(f"Expected OpenType 'tnum' feature in {dest.name}, found: {sorted(tags)}")

    # Preserve nameIDs 13/14 (OFL license)
    name_ids = {rec.nameID for rec in font["name"].names}
    if 13 not in name_ids or 14 not in name_ids:
        raise RuntimeError(f"License nameIDs 13/14 missing from {dest.name}: {sorted(name_ids)}")

    subset.save_font(font, str(dest), opts)
    if dest.read_bytes()[:4] != b"wOF2":
        raise RuntimeError(f"{dest.name} did not serialize with WOFF2 magic bytes")

    actual_cmap = set(font.getBestCmap().keys())
    return actual_cmap & codepoints


def verify_output(out_dir: Path) -> None:
    woff2_files = sorted(out_dir.glob("*.woff2"))
    if not woff2_files:
        raise RuntimeError("No .woff2 files generated")
    css_text = (out_dir / "fonts.css").read_text(encoding="utf-8")
    css_urls = re.findall(r"url\('/fonts/([^']+)'\)\s+format\('woff2'\)", css_text)
    if "http://" in css_text or "https://" in css_text:
        raise RuntimeError("External font URL found in fonts.css")
    if sorted(css_urls) != [p.name for p in woff2_files]:
        raise RuntimeError("Mismatch between fonts.css URLs and generated .woff2 files")
    if not (out_dir / "OFL.txt").exists():
        raise RuntimeError("Missing OFL.txt in public/fonts/")

    for p in woff2_files:
        header = p.read_bytes()[:4]
        if header != b"wOF2":
            raise RuntimeError(f"{p.name}: invalid magic {header!r}, expected b'wOF2'")
        tf = TTFont(p)
        if tf.flavor != "woff2":
            raise RuntimeError(f"{p.name}: TTFont.flavor={tf.flavor!r}, expected 'woff2'")
        name_ids = {rec.nameID for rec in tf["name"].names}
        if 13 not in name_ids or 14 not in name_ids:
            raise RuntimeError(f"{p.name}: missing OFL nameIDs 13/14")
        if p.name.startswith("inter-"):
            gsub = tf.get("GSUB")
            tags = (
                {rec.FeatureTag for rec in gsub.table.FeatureList.FeatureRecord}
                if gsub and gsub.table.FeatureList
                else set()
            )
            if "tnum" not in tags:
                raise RuntimeError(f"{p.name}: missing 'tnum' in GSUB")
    print(f"Verified {len(woff2_files)} genuine WOFF2 files (magic=wOF2, flavor=woff2, OFL+tnum ok)", flush=True)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not SANS_SOURCE.exists():
        raise FileNotFoundError(
            f"Missing NotoSansSC source: {SANS_SOURCE} (set NOTO_SANS_SC_TTF or FONT_SRC_DIR)"
        )

    existing_ofl = (OUT_DIR / "OFL.txt").read_text(encoding="utf-8") if (OUT_DIR / "OFL.txt").exists() else None
    # Remove stale files in public/fonts/
    for old in OUT_DIR.iterdir():
        if old.is_file():
            old.unlink()

    inter_path = ensure_cached_font("Inter[opsz,wght].ttf")
    mono_path = ensure_cached_font("JetBrainsMono[wght].ttf")
    serif_path = ensure_cached_font("NotoSerifSC[wght].ttf")

    if OFL_SOURCE.exists() and OFL_SOURCE.resolve() != (OUT_DIR / "OFL.txt").resolve():
        shutil.copy2(OFL_SOURCE, OUT_DIR / "OFL.txt")
    elif existing_ofl is not None:
        (OUT_DIR / "OFL.txt").write_text(existing_ofl, encoding="utf-8")

    css_blocks: list[str] = [
        "/* Self-hosted static WOFF2 font subsets generated by scripts/build-fonts.py */",
        "",
    ]

    # 1. Inter (400, 500, 600) with tnum preserved
    inter_cps = (
        set(range(0x0020, 0x007F))
        | set(range(0x00A0, 0x0180))
        | set(range(0x2000, 0x2070))
        | set(range(0x2190, 0x21A0))
        | set(map(ord, "·—…°′″×÷±≈≠≤≥€£¥©®™•"))
    )
    inter_src = TTFont(inter_path)
    for weight in (400, 500, 600):
        out_name = f"inter-{weight}.woff2"
        out_path = OUT_DIR / out_name
        static_font = instantiate_static(inter_src, {"wght": weight, "opsz": 14})
        covered = subset_to_woff2(
            static_font, inter_cps, out_path, verify_tnum=True
        )
        css_blocks.append(
            f"@font-face {{\n"
            f"  font-family: 'Inter';\n"
            f"  font-style: normal;\n"
            f"  font-weight: {weight};\n"
            f"  font-display: swap;\n"
            f"  src: url('/fonts/{out_name}') format('woff2');\n"
            f"  unicode-range: {format_unicode_range(covered)};\n"
            f"}}\n"
        )
        print(f"Built {out_name}: {out_path.stat().st_size / 1024:.1f} KB ({len(covered)} cps)", flush=True)

    # 2. JetBrains Mono (400, 500)
    mono_cps = (
        set(range(0x0020, 0x007F))
        | set(range(0x00A0, 0x0100))
        | set(range(0x2000, 0x2070))
        | set(range(0x2190, 0x21A0))
        | set(map(ord, "°′″×÷±≈≠≤≥•"))
    )
    mono_src = TTFont(mono_path)
    for weight in (400, 500):
        out_name = f"jetbrains-mono-{weight}.woff2"
        out_path = OUT_DIR / out_name
        static_font = instantiate_static(mono_src, {"wght": weight})
        covered = subset_to_woff2(static_font, mono_cps, out_path)
        css_blocks.append(
            f"@font-face {{\n"
            f"  font-family: 'JetBrains Mono';\n"
            f"  font-style: normal;\n"
            f"  font-weight: {weight};\n"
            f"  font-display: swap;\n"
            f"  src: url('/fonts/{out_name}') format('woff2');\n"
            f"  unicode-range: {format_unicode_range(covered)};\n"
            f"}}\n"
        )
        print(f"Built {out_name}: {out_path.stat().st_size / 1024:.1f} KB ({len(covered)} cps)", flush=True)

    # 3. Noto Sans SC & Noto Serif SC two-tier disjoint unicode-range subsets
    core_cjk = collect_core_cjk()
    non_cjk = base_non_cjk_points()

    for family, prefix, src_path in [
        ("Noto Sans SC", "noto-sans-sc", SANS_SOURCE),
        ("Noto Serif SC", "noto-serif-sc", serif_path),
    ]:
        src_font = TTFont(src_path)
        full_cmap = set(src_font.getBestCmap().keys())
        basic_cjk = sorted(cp for cp in full_cmap if 0x4E00 <= cp <= 0x9FFF)
        core_points = (non_cjk | core_cjk) & full_cmap
        remaining_cjk = [cp for cp in basic_cjk if cp not in core_points]

        chunk_size = 1000
        ext_chunks = [
            set(remaining_cjk[i : i + chunk_size])
            for i in range(0, len(remaining_cjk), chunk_size)
        ]

        for weight in (400, 500, 600):
            static_font = instantiate_static(src_font, {"wght": weight})
            # Core slice
            core_name = f"{prefix}-{weight}-core.woff2"
            core_path = OUT_DIR / core_name
            covered_core = subset_to_woff2(static_font, core_points, core_path)
            css_blocks.append(
                f"@font-face {{\n"
                f"  font-family: '{family}';\n"
                f"  font-style: normal;\n"
                f"  font-weight: {weight};\n"
                f"  font-display: swap;\n"
                f"  src: url('/fonts/{core_name}') format('woff2');\n"
                f"  unicode-range: {format_unicode_range(covered_core)};\n"
                f"}}\n"
            )
            print(f"Built {core_name}: {core_path.stat().st_size / 1024:.1f} KB ({len(covered_core)} cps)", flush=True)

            # Ext slices
            for idx, ext_cps in enumerate(ext_chunks, start=1):
                ext_name = f"{prefix}-{weight}-ext-{idx:02d}.woff2"
                ext_path = OUT_DIR / ext_name
                covered_ext = subset_to_woff2(static_font, ext_cps, ext_path)
                if not covered_ext:
                    ext_path.unlink(missing_ok=True)
                    continue
                css_blocks.append(
                    f"@font-face {{\n"
                    f"  font-family: '{family}';\n"
                    f"  font-style: normal;\n"
                    f"  font-weight: {weight};\n"
                    f"  font-display: swap;\n"
                    f"  src: url('/fonts/{ext_name}') format('woff2');\n"
                    f"  unicode-range: {format_unicode_range(covered_ext)};\n"
                    f"}}\n"
                )
            print(f"Built {prefix}-{weight}-ext-01..{len(ext_chunks):02d}.woff2 ({len(remaining_cjk)} CJK cps)", flush=True)

    (OUT_DIR / "fonts.css").write_text("\n".join(css_blocks), encoding="utf-8")
    print(f"Wrote {OUT_DIR / 'fonts.css'} ({len(list(OUT_DIR.glob('*.woff2')))} WOFF2 files)", flush=True)
    verify_output(OUT_DIR)


if __name__ == "__main__":
    main()
