#!/usr/bin/env python3
"""NoteFast .md 文档图标生成器（Typora 风格：文档页 + markdown M↓ logo）。

生成产物（供文件关联使用，区别于 App 图标）：
  - clients/apple/Resources/DocIcon.icns   macOS 文档图标
  - clients/tauri/src-tauri/icons/md-doc.ico  Windows 关联图标
  - clients/tauri/src-tauri/icons/md-doc.png  512 预览

用法: python3 gen-doc-icon.py
依赖: Pillow（pip install pillow）
"""

import io
import os
from PIL import Image, ImageDraw

SIZE = 1024
PRIMARY = (90, 116, 176)          # 品牌石板靛蓝 #5A74B0
PAGE_WHITE = (255, 255, 255, 255)
PAGE_BORDER = (212, 218, 230, 255)
FOLD_SHADE = (238, 241, 247, 255)

HERE = os.path.dirname(os.path.abspath(__file__))
APPLE_ICNS = os.path.normpath(os.path.join(HERE, "../Resources/DocIcon.icns"))
TAURI_ICO = os.path.normpath(os.path.join(HERE, "../../tauri/src-tauri/icons/md-doc.ico"))
TAURI_PNG = os.path.normpath(os.path.join(HERE, "../../tauri/src-tauri/icons/md-doc.png"))


def draw_markdown_m2(d: ImageDraw.ImageDraw, cx: int, cy: int) -> None:
    """居中绘制 markdown 风格的粗体 M（多边形，比字体 M 更接近 daringfireball logo）。"""
    w = 300
    bar = 58
    top = cy - 150
    bottom = cy + 110
    point = cy + 200
    left = cx - w / 2
    right = cx + w / 2
    inner_l = left + bar
    inner_r = right - bar

    d.polygon([(left, top), (inner_l, top), (inner_l, bottom), (left, bottom)], fill=PRIMARY)
    d.polygon([(inner_r, top), (right, top), (right, bottom), (inner_r, bottom)], fill=PRIMARY)
    d.polygon([(inner_l, bottom - bar / 2), (inner_l, bottom), (cx, point), (cx, point - bar)], fill=PRIMARY)
    d.polygon([(inner_r, bottom - bar / 2), (inner_r, bottom), (cx, point), (cx, point - bar)], fill=PRIMARY)
    d.polygon([(cx - bar / 2, point - bar), (cx + bar / 2, point - bar), (cx, point)], fill=PRIMARY)


def draw_down_arrow(d: ImageDraw.ImageDraw, cx: int, top_y: int) -> None:
    """下箭头：竖线 + 实心三角（markdown ↓ 的一部分），紧贴 M 尖底形成一体。"""
    shaft_w = 40
    shaft_bot = top_y + 70
    d.line([(cx, top_y), (cx, shaft_bot)], fill=PRIMARY, width=shaft_w)
    d.polygon(
        [(cx - 60, shaft_bot - 10), (cx + 60, shaft_bot - 10), (cx, shaft_bot + 64)],
        fill=PRIMARY,
    )


def draw_master() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    margin = 72
    # 文档页
    d.rounded_rectangle(
        [margin, margin, SIZE - margin, SIZE - margin],
        radius=170,
        fill=PAGE_WHITE,
        outline=PAGE_BORDER,
        width=6,
    )
    # 右上折角
    fold = 210
    d.polygon(
        [(SIZE - margin - fold, margin), (SIZE - margin, margin), (SIZE - margin, margin + fold)],
        fill=FOLD_SHADE,
    )
    d.line([(SIZE - margin - fold, margin), (SIZE - margin, margin + fold)], fill=PAGE_BORDER, width=6)

    # M↓ logo（品牌色）：箭头杆顶叠进 M 尖底（5px），任意尺寸下都连成一体
    cx = SIZE // 2
    draw_markdown_m2(d, cx, 455)
    draw_down_arrow(d, cx, 650)

    return img


def build_icns(pngs: dict[int, bytes]) -> bytes:
    types = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07", 256: b"ic08", 512: b"ic09", 1024: b"ic10"}
    chunks = b""
    for size, data in pngs.items():
        chunks += types[size] + (len(data) + 8).to_bytes(4, "big") + data
    return b"icns" + (len(chunks) + 8).to_bytes(4, "big") + chunks


def main() -> None:
    master = draw_master()

    # 预览（供人检查）
    preview = os.path.join(HERE, "doc-icon-preview.png")
    master.save(preview)
    print("preview:", preview)

    # ICNS：各尺寸 PNG 内嵌
    pngs: dict[int, bytes] = {}
    for size in (16, 32, 64, 128, 256, 512, 1024):
        buf = io.BytesIO()
        master.resize((size, size), Image.Resampling.LANCZOS).save(buf, format="PNG")
        pngs[size] = buf.getvalue()
    with open(APPLE_ICNS, "wb") as f:
        f.write(build_icns(pngs))
    print("icns:", APPLE_ICNS)

    # ICO：多尺寸
    master.resize((256, 256), Image.Resampling.LANCZOS).save(
        TAURI_ICO,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("ico:", TAURI_ICO)

    master.save(TAURI_PNG)
    print("png:", TAURI_PNG)


if __name__ == "__main__":
    main()
