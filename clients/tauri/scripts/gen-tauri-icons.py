#!/usr/bin/env python3
"""
NoteFast Tauri 图标生成器（Windows 打包用 PNG + ICO）
从 favicon.svg 几何直接光栅化（25% 圆角 + 左对齐三线），超采样抗锯齿，
不依赖 ImageMagick / cairo；输出替换 clients/tauri/src-tauri/icons/ 下的
32x32.png / 64x64.png / 128x128.png / 128x128@2x.png / icon.png / icon.ico
以及 Square*/StoreLogo 系列（Windows 商店 Logo 需无圆角安全区，但统一风格）。
用法: python3 gen_tauri_icons.py
"""
import math
import os
import struct
import zlib

BLUE = (59, 130, 246)   # #3b82f6 与 favicon 一致
WHITE = (255, 255, 255)
SS = 4                   # 超采样倍数（边缘抗锯齿）


def sd_rounded_rect(px, py, cx, cy, hw, hh, r):
    """有符号距离：圆角矩形内为负。"""
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ox = max(qx, 0.0)
    oy = max(qy, 0.0)
    return math.hypot(ox, oy) + min(max(qx, qy), 0.0) - r


def sd_segment(px, py, ax, ay, bx, by):
    """到线段（不含端点半径）的距离。"""
    pax = px - ax
    pay = py - ay
    bax = bx - ax
    bay = by - ay
    h = (pax * bax + pay * bay) / (bax * bax + bay * bay)
    h = max(0.0, min(1.0, h))
    return math.hypot(pax - bax * h, pay - bay * h)


def render_icon(size):
    """按 size 渲染 RGBA 像素（超采样平均，straight alpha）。"""
    W = size * SS
    R = W * 0.25          # rx=8/32 → 25%
    cx = cy = W / 2.0
    hw = hh = W / 2.0
    # 三线（favicon 32 坐标系 → W）
    def lx(v): return v / 32.0 * W
    bars = [
        (lx(8), lx(24), lx(10)),   # x0, x1, yc
        (lx(8), lx(20), lx(16)),
        (lx(8), lx(18), lx(22)),
    ]
    half = lx(2.5) / 2.0

    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            r_acc = g_acc = b_acc = a_acc = 0
            for sy in range(SS):
                for sx in range(SS):
                    px = x * SS + sx + 0.5
                    py = y * SS + sy + 0.5
                    if sd_rounded_rect(px, py, cx, cy, hw, hh, R) > 0:
                        continue  # 圆角外 → 透明
                    col = BLUE
                    for (x0, x1, yc) in bars:
                        if sd_segment(px, py, x0, yc, x1, yc) - half <= 0:
                            col = WHITE
                            break
                    r_acc += col[0]
                    g_acc += col[1]
                    b_acc += col[2]
                    a_acc += 255
            n = SS * SS
            o = (y * size + x) * 4
            if a_acc > 0:
                out[o] = min(255, r_acc * 255 // n)
                out[o + 1] = min(255, g_acc * 255 // n)
                out[o + 2] = min(255, b_acc * 255 // n)
                out[o + 3] = a_acc // n
            else:
                out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0
    return bytes(out)


def encode_png(w, h, rgba):
    """RGBA → PNG（zlib + 手写 chunk）。"""
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    idat = zlib.compress(bytes(raw), 9)

    def chunk(typ, payload):
        c = struct.pack('>I', len(payload)) + typ + payload
        crc = 0xFFFFFFFF
        for b in c[4:]:
            crc ^= b
            for _ in range(8):
                crc = (crc >> 1) ^ (0xEDB88320 if crc & 1 else 0)
        return c + struct.pack('>I', crc ^ 0xFFFFFFFF)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')


def encode_ico(frames):
    """frames: [(w, h, png_bytes)] → ICO（PNG 帧，Vista+ 支持）。"""
    header = struct.pack('<HHH', 0, 1, len(frames))
    entries = b''
    blobs = b''
    offset = 6 + 16 * len(frames)
    for w, h, png in frames:
        # ICO 目录字节：0 表示 256；其余直接存
        bw = 0 if w >= 256 else w
        bh = 0 if h >= 256 else h
        entries += struct.pack('<BBBBHHII', bw, bh, 0, 0, 1, 32, len(png), offset)
        blobs += png
        offset += len(png)
    return header + entries + blobs


def main():
    root = 'clients/tauri/src-tauri/icons'
    os.makedirs(root, exist_ok=True)

    # 1) bundle 引用的 PNG
    png_sizes = {
        '32x32.png': 32,
        '64x64.png': 64,
        '128x128.png': 128,
        '128x128@2x.png': 256,
        'icon.png': 512,
    }
    for name, size in png_sizes.items():
        png = encode_png(size, size, render_icon(size))
        with open(os.path.join(root, name), 'wb') as f:
            f.write(png)
        print(f'{name}: {size}x{size} ({len(png)}B)')

    # 2) Windows Store Logo 系列（含安全区，统一同风格圆角）
    store_sizes = {
        'Square30x30Logo.png': 30,
        'Square44x44Logo.png': 44,
        'Square71x71Logo.png': 71,
        'Square89x89Logo.png': 89,
        'Square107x107Logo.png': 107,
        'Square142x142Logo.png': 142,
        'Square150x150Logo.png': 150,
        'Square284x284Logo.png': 284,
        'Square310x310Logo.png': 310,
        'StoreLogo.png': 50,
    }
    for name, size in store_sizes.items():
        png = encode_png(size, size, render_icon(size))
        with open(os.path.join(root, name), 'wb') as f:
            f.write(png)
        print(f'{name}: {size}x{size} ({len(png)}B)')

    # 3) icon.ico（16/24/32/48/64/256 帧）
    ico_frames = [(s, s, encode_png(s, s, render_icon(s))) for s in (16, 24, 32, 48, 64, 256)]
    ico = encode_ico(ico_frames)
    with open(os.path.join(root, 'icon.ico'), 'wb') as f:
        f.write(ico)
    print(f'icon.ico: {len(ico)}B, frames={[w for w, _, _ in ico_frames]}')

    print('done.')


if __name__ == '__main__':
    main()
