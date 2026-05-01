#!/usr/bin/env python3
"""Generate the six placeholder CCTV GIFs for the Security view.

Output goes to ../public/security/{name}.gif. Each GIF is 320x200
(matches the .sec-tile aspect ratio of 16:10), 16 frames at 10 fps,
producing a 1.6-second loop that's small enough to ship in the repo
(~30-50 KB each) and instantly recognisable as a CCTV feed.

Style notes
-----------
* Cool low-saturation palette — these are meant to read as "security
  camera footage", not glossy renders.
* A subtle horizontal scanline overlay + corner vignette is composited
  on every scene to pull the disparate sketches into one visual family.
* Each scene picks one element to animate (ripples, a walking
  silhouette, a turbine, etc.). Everything else is static — a dozen
  moving things in 320x200 just looks busy.

To regenerate:  python3 generate_camera_gifs.py
"""

from __future__ import annotations

import math
import os
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---- Output ----------------------------------------------------------

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / "public" / "security"
OUT_DIR.mkdir(parents=True, exist_ok=True)

W, H = 320, 200          # tile aspect = 16:10
FRAMES = 16              # frames per loop
FPS = 10                 # 1.6-second loop
DURATION_MS = int(1000 / FPS)

# ---- Palette helpers -------------------------------------------------

def mix(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))


# CCTV-y cool greys/blues
NIGHT_DEEP = (12, 18, 28)
NIGHT_MID = (24, 38, 58)
NIGHT_HI = (60, 84, 110)

# Warm interior tones
WARM_DEEP = (38, 28, 22)
WARM_MID = (78, 56, 38)
WARM_HI = (160, 120, 80)
WARM_GLOW = (210, 180, 110)

# Daylight/sea tones
SEA_DEEP = (24, 50, 78)
SEA_MID = (52, 92, 128)
SEA_HI = (110, 158, 190)
SKY_HI = (180, 200, 218)

# ---- Compositing ----------------------------------------------------

def add_scanlines(img: Image.Image) -> None:
    """Faint dark horizontal lines every 2px — sells the CCTV vibe."""
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    for y in range(0, img.height, 2):
        d.line([(0, y), (img.width, y)], fill=(0, 0, 0, 28))
    img.alpha_composite(overlay)


def add_vignette(img: Image.Image) -> None:
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    # Four corner darkenings
    for corner in [(0, 0), (img.width, 0), (0, img.height), (img.width, img.height)]:
        for r in range(60, 0, -6):
            alpha = int(70 * (1 - r / 60))
            d.ellipse(
                [corner[0] - r, corner[1] - r, corner[0] + r, corner[1] + r],
                fill=(0, 0, 0, alpha),
            )
    img.alpha_composite(overlay)


def add_noise(img: Image.Image, frame_idx: int) -> None:
    """Sprinkle a handful of bright pixels — sensor noise."""
    rng = random.Random(frame_idx * 7919)
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    for _ in range(60):
        x = rng.randint(0, img.width - 1)
        y = rng.randint(0, img.height - 1)
        v = rng.randint(80, 180)
        d.point((x, y), fill=(v, v, v, 70))
    img.alpha_composite(overlay)


def finish_frame(img: Image.Image, frame_idx: int) -> Image.Image:
    add_noise(img, frame_idx)
    add_scanlines(img)
    add_vignette(img)
    # Pillow's RGBA→P quantizer can collapse subtle dark blues into wild
    # reds when it gets confused by the alpha channel, so flatten to a
    # solid-black background first, then quantize to GIF's full 256-
    # colour palette.
    flat = Image.new("RGB", img.size, (0, 0, 0))
    flat.paste(img, mask=img.split()[3])
    return flat.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)


def save_gif(name: str, frames: list[Image.Image]) -> None:
    out = OUT_DIR / f"{name}.gif"
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=DURATION_MS,
        loop=0,
        optimize=True,
        disposal=2,
    )
    size = out.stat().st_size
    print(f"  wrote {out.name}  ({size//1024} KB, {len(frames)} frames)")


# ---- Scene 1 — Bridge (Helm) ----------------------------------------

def scene_bridge(t: float) -> Image.Image:
    img = Image.new("RGBA", (W, H), NIGHT_DEEP + (255,))
    d = ImageDraw.Draw(img)

    # Window band — view of the bow + horizon at night.
    # Sky gradient
    for y in range(0, 80):
        c = mix(NIGHT_DEEP, NIGHT_MID, y / 80)
        d.line([(0, y), (W, y)], fill=c + (255,))
    # Distant horizon glow
    for y in range(70, 90):
        c = mix(NIGHT_MID, (50, 70, 90), (y - 70) / 20)
        d.line([(0, y), (W, y)], fill=c + (255,))
    # Window mullions
    d.rectangle([0, 0, W, 6], fill=(20, 28, 40, 255))
    d.rectangle([0, 86, W, 92], fill=(20, 28, 40, 255))
    for x in (78, 158, 238):
        d.rectangle([x - 2, 6, x + 2, 86], fill=(20, 28, 40, 255))

    # Two distant ship lights on the horizon, slowly drifting.
    drift = (math.sin(t * 2 * math.pi) * 4)
    d.ellipse([130 + drift, 78, 134 + drift, 82], fill=(220, 200, 140, 255))
    d.ellipse([220 - drift, 80, 222 - drift, 82], fill=(190, 170, 110, 255))

    # Console — dark band across the bottom with status lights.
    d.rectangle([0, 130, W, H], fill=(18, 24, 34, 255))
    d.rectangle([0, 130, W, 134], fill=(40, 60, 86, 255))

    # Helm wheel silhouette — circle with spokes.
    cx, cy, r = W // 2, 158, 22
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(30, 40, 56), width=2)
    for i in range(8):
        ang = i * math.pi / 4
        d.line(
            [
                (cx + math.cos(ang) * 4, cy + math.sin(ang) * 4),
                (cx + math.cos(ang) * (r - 2), cy + math.sin(ang) * (r - 2)),
            ],
            fill=(30, 40, 56),
            width=1,
        )
    d.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=(30, 40, 56, 255))

    # Helmsperson silhouette behind the wheel.
    d.ellipse([cx - 9, cy - 36, cx + 9, cy - 18], fill=(8, 12, 18, 255))  # head
    d.rectangle([cx - 18, cy - 20, cx + 18, cy + 6], fill=(8, 12, 18, 255))  # shoulders

    # Console blinkenlights — pseudo-random by frame.
    rng = random.Random(int(t * 1000) // 100)
    for col in range(8):
        x = 30 + col * 35
        for row in range(3):
            y = 138 + row * 6
            on = rng.random() < 0.55
            if 110 < x < 210 and y > 145:
                continue  # leave space behind helm
            color = (
                (90, 200, 130, 255) if on and rng.random() < 0.6
                else (200, 130, 60, 255) if on
                else (40, 50, 64, 255)
            )
            d.rectangle([x, y, x + 4, y + 3], fill=color)

    return img


# ---- Scene 2 — Atrium (Grand Lobby) ---------------------------------

def scene_atrium(t: float) -> Image.Image:
    img = Image.new("RGBA", (W, H), (28, 24, 22, 255))
    d = ImageDraw.Draw(img)

    # Vertical gradient — warm interior.
    for y in range(H):
        c = mix(WARM_DEEP, (52, 38, 30), y / H)
        d.line([(0, y), (W, y)], fill=c + (255,))

    # Atrium back wall — tall arch.
    d.rectangle([0, 50, W, H], fill=(48, 36, 28, 255))
    d.polygon([(40, 50), (W - 40, 50), (W - 60, 30), (60, 30)], fill=(58, 42, 30, 255))

    # Chandelier + glow.
    cx, cy = W // 2, 30
    flicker = 1.0 + 0.10 * math.sin(t * 2 * math.pi * 3)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for r in range(40, 0, -4):
        a = int(40 * (1 - r / 40) * flicker)
        gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 200, 120, a))
    glow = glow.filter(ImageFilter.GaussianBlur(2))
    img.alpha_composite(glow)
    d = ImageDraw.Draw(img)
    d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=(255, 220, 150, 255))

    # Reception desk band.
    d.rectangle([0, 130, W, 152], fill=(36, 26, 20, 255))
    d.rectangle([0, 128, W, 132], fill=(80, 58, 38, 255))
    # Counter top highlight under chandelier.
    d.rectangle([cx - 50, 128, cx + 50, 132], fill=(120, 90, 60, 255))

    # Floor tiles — diagonal gradient.
    for y in range(152, H):
        c = mix((44, 32, 24), (24, 18, 14), (y - 152) / (H - 152))
        d.line([(0, y), (W, y)], fill=c + (255,))
    # Tile lines
    for x in range(0, W, 40):
        d.line([(x, 152), (x + 30, H)], fill=(70, 52, 38, 200), width=1)

    # Pillars
    for x in (50, W - 50):
        d.rectangle([x - 8, 50, x + 8, 152], fill=(64, 46, 32, 255))
        d.rectangle([x - 12, 48, x + 12, 56], fill=(80, 58, 40, 255))
        d.rectangle([x - 12, 148, x + 12, 156], fill=(80, 58, 40, 255))

    # Two strollers — one moving left to right, one in the back.
    pos1 = (t * 1.0) % 1.0
    sx = int(20 + pos1 * (W - 40))
    sy = 158
    # Body
    d.ellipse([sx - 6, sy - 26, sx + 6, sy - 14], fill=(20, 14, 10, 255))  # head
    d.rectangle([sx - 8, sy - 14, sx + 8, sy + 4], fill=(20, 14, 10, 255))  # torso
    # Walking legs (sway)
    leg_phase = math.sin(t * 2 * math.pi * 4) * 4
    d.line([(sx - 2, sy + 4), (sx - 2 + leg_phase, sy + 16)], fill=(20, 14, 10, 255), width=3)
    d.line([(sx + 2, sy + 4), (sx + 2 - leg_phase, sy + 16)], fill=(20, 14, 10, 255), width=3)

    # Background figure (small, in the distance).
    pos2 = (1.0 - (t * 0.6) % 1.0)
    bx = int(60 + pos2 * (W - 120))
    by = 116
    d.ellipse([bx - 3, by - 8, bx + 3, by - 2], fill=(14, 10, 8, 255))
    d.rectangle([bx - 4, by - 2, bx + 4, by + 8], fill=(14, 10, 8, 255))

    return img


# ---- Scene 3 — Engine Room ------------------------------------------

def scene_engine(t: float) -> Image.Image:
    img = Image.new("RGBA", (W, H), (16, 18, 18, 255))
    d = ImageDraw.Draw(img)

    # Gritty back wall.
    for y in range(H):
        c = mix((22, 26, 30), (10, 12, 14), y / H)
        d.line([(0, y), (W, y)], fill=c + (255,))

    # Pipe rack across the top.
    for i, (col, y) in enumerate([
        ((150, 70, 50), 18),
        ((90, 90, 100), 32),
        ((180, 130, 60), 46),
    ]):
        d.rectangle([0, y, W, y + 8], fill=col + (255,))
        # rivets
        for x in range(8, W, 18):
            d.ellipse([x - 1, y + 3, x + 2, y + 6], fill=(30, 30, 36, 255))

    # Floor grating.
    for y in range(150, H, 4):
        d.line([(0, y), (W, y)], fill=(38, 42, 48, 255), width=1)
    for x in range(0, W, 14):
        d.line([(x, 150), (x, H)], fill=(48, 52, 60, 255), width=1)

    # Main turbine — big circle with rotating blades.
    cx, cy, R = 110, 110, 44
    # Housing
    d.ellipse([cx - R - 4, cy - R - 4, cx + R + 4, cy + R + 4], fill=(54, 54, 60, 255))
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=(20, 22, 28, 255))
    d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=(90, 96, 108), width=2)
    # Spinning blades — 5 blades
    rot = t * 2 * math.pi * 4  # 4 revolutions per loop
    for i in range(5):
        ang = rot + i * (2 * math.pi / 5)
        x1 = cx + math.cos(ang) * 6
        y1 = cy + math.sin(ang) * 6
        x2 = cx + math.cos(ang) * (R - 4)
        y2 = cy + math.sin(ang) * (R - 4)
        d.line([(x1, y1), (x2, y2)], fill=(140, 150, 170, 255), width=4)
    # Hub
    d.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], fill=(180, 190, 200, 255))
    d.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=(60, 70, 80, 255))

    # Secondary smaller turbine on the right.
    cx2, cy2, R2 = 230, 120, 24
    d.ellipse([cx2 - R2 - 2, cy2 - R2 - 2, cx2 + R2 + 2, cy2 + R2 + 2], fill=(54, 54, 60, 255))
    d.ellipse([cx2 - R2, cy2 - R2, cx2 + R2, cy2 + R2], fill=(20, 22, 28, 255))
    rot2 = -t * 2 * math.pi * 6
    for i in range(4):
        ang = rot2 + i * (math.pi / 2)
        x2a = cx2 + math.cos(ang) * 4
        y2a = cy2 + math.sin(ang) * 4
        x2b = cx2 + math.cos(ang) * (R2 - 2)
        y2b = cy2 + math.sin(ang) * (R2 - 2)
        d.line([(x2a, y2a), (x2b, y2b)], fill=(140, 150, 170, 255), width=3)
    d.ellipse([cx2 - 4, cy2 - 4, cx2 + 4, cy2 + 4], fill=(180, 190, 200, 255))

    # Status panel — green/amber LEDs (slow blink).
    panel_x, panel_y = W - 70, 80
    d.rectangle([panel_x, panel_y, panel_x + 60, panel_y + 30], fill=(40, 42, 50, 255))
    rng = random.Random(int(t * 100) // 30)
    for c in range(4):
        for r in range(2):
            led_x = panel_x + 8 + c * 12
            led_y = panel_y + 8 + r * 10
            on = rng.random() < 0.7
            color = (60, 200, 120) if on else (180, 130, 50) if rng.random() < 0.3 else (30, 36, 44)
            d.ellipse([led_x, led_y, led_x + 4, led_y + 4], fill=color + (255,))

    return img


# ---- Scene 4 — Promenade (Port Side) --------------------------------

def scene_promenade(t: float) -> Image.Image:
    img = Image.new("RGBA", (W, H), (40, 32, 28, 255))
    d = ImageDraw.Draw(img)

    # Floor (warm wooden deck).
    for y in range(H):
        c = mix((48, 36, 28), (28, 22, 18), y / H)
        d.line([(0, y), (W, y)], fill=c + (255,))

    # Wall behind on the left (interior).
    d.polygon([(0, 0), (110, 40), (110, H), (0, H)], fill=(64, 48, 36, 255))

    # Window strip on the right showing the sea passing by.
    win_x = 130
    d.rectangle([win_x, 0, W, H], fill=NIGHT_MID + (255,))
    # Sky band
    for y in range(0, 60):
        c = mix((30, 50, 80), (90, 130, 160), y / 60)
        d.line([(win_x, y), (W, y)], fill=c + (255,))
    # Horizon line
    d.line([(win_x, 100), (W, 100)], fill=(60, 90, 130, 255), width=1)
    # Sea band — moving wave lines.
    for y in range(100, H):
        c = mix((32, 60, 90), (12, 24, 40), (y - 100) / (H - 100))
        d.line([(win_x, y), (W, y)], fill=c + (255,))
    # Animated wave streaks (drift right→left to simulate forward motion).
    streak_offset = t * W
    for i in range(7):
        wy = 110 + i * 14
        amp = 2 + (i % 3)
        for x in range(win_x, W, 6):
            phase = ((x + streak_offset) / 22) + (i * 0.6)
            yy = wy + math.sin(phase) * amp
            d.line([(x, yy), (x + 4, yy)], fill=(140, 170, 200, 200), width=1)

    # Window mullions.
    d.rectangle([win_x - 3, 0, win_x + 1, H], fill=(36, 28, 22, 255))
    for x in (180, 230, 280):
        d.rectangle([x, 0, x + 2, H], fill=(36, 28, 22, 255))
    d.rectangle([win_x, 0, W, 4], fill=(36, 28, 22, 255))
    d.rectangle([win_x, H - 6, W, H], fill=(36, 28, 22, 255))

    # Ceiling lights — small pools on the floor.
    for x in (35, 75, 110):
        d.ellipse([x - 8, 145, x + 8, 165], fill=(110, 80, 50, 255))
        d.ellipse([x - 4, 150, x + 4, 158], fill=(180, 140, 90, 255))

    # Lone passenger walking, their reflection on the dark wood.
    pos = (t * 0.7) % 1.2 - 0.1
    sx = int(20 + pos * (win_x - 30))
    if 0 < sx < win_x - 10:
        d.ellipse([sx - 4, 122, sx + 4, 132], fill=(18, 14, 10, 255))
        d.rectangle([sx - 5, 132, sx + 5, 152], fill=(18, 14, 10, 255))
        # subtle reflection
        d.rectangle([sx - 3, 152, sx + 3, 158], fill=(28, 20, 14, 255))

    return img


# ---- Scene 5 — Lido Pool Deck ---------------------------------------

def scene_pool(t: float) -> Image.Image:
    img = Image.new("RGBA", (W, H), (90, 130, 160, 255))
    d = ImageDraw.Draw(img)

    # Sky gradient.
    for y in range(0, 90):
        c = mix(SKY_HI, (130, 170, 200), y / 90)
        d.line([(0, y), (W, y)], fill=c + (255,))

    # Distant horizon — sea band beyond the deck.
    for y in range(90, 110):
        c = mix((90, 140, 170), (60, 110, 150), (y - 90) / 20)
        d.line([(0, y), (W, y)], fill=c + (255,))

    # Deck floor.
    for y in range(110, H):
        c = mix((180, 170, 150), (140, 130, 110), (y - 110) / (H - 110))
        d.line([(0, y), (W, y)], fill=c + (255,))
    # Deck planks
    for x in range(0, W, 22):
        d.line([(x, 110), (x, H)], fill=(120, 110, 90, 200), width=1)

    # Pool — turquoise rectangle.
    pool = [60, 122, 260, 178]
    d.rectangle(pool, fill=(40, 130, 160, 255))
    # Pool tile rim
    d.rectangle([pool[0] - 4, pool[1] - 3, pool[2] + 4, pool[1]], fill=(220, 220, 220, 255))
    d.rectangle([pool[0] - 4, pool[3], pool[2] + 4, pool[3] + 3], fill=(220, 220, 220, 255))
    d.rectangle([pool[0] - 4, pool[1], pool[0], pool[3]], fill=(220, 220, 220, 255))
    d.rectangle([pool[2], pool[1], pool[2] + 4, pool[3]], fill=(220, 220, 220, 255))

    # Animated ripples on pool surface.
    px0, py0, px1, py1 = pool
    for i in range(6):
        wy = py0 + 6 + i * 8
        if wy >= py1 - 4:
            break
        amp = 1.6 + (i % 2)
        for x in range(px0 + 4, px1 - 4, 4):
            phase = ((x + t * 80) / 12) + (i * 0.7)
            yy = wy + math.sin(phase) * amp
            d.line([(x, yy), (x + 2, yy)], fill=(180, 220, 240, 220), width=1)
    # A swimmer — small dark dot drifting.
    sx = int(px0 + 20 + ((t * 0.5) % 1.0) * (px1 - px0 - 40))
    sy = py0 + 30
    d.ellipse([sx - 4, sy - 3, sx + 4, sy + 3], fill=(40, 50, 60, 255))
    d.line([(sx - 6, sy), (sx + 6, sy)], fill=(40, 50, 60, 255), width=1)

    # Two deck chairs in the foreground corners.
    for cx in (24, W - 32):
        d.polygon(
            [(cx, 184), (cx + 18, 184), (cx + 14, 174), (cx + 4, 174)],
            fill=(220, 215, 200, 255),
        )
        d.line([(cx + 4, 174), (cx + 4, 168)], fill=(180, 175, 160, 255), width=2)

    # Parasol — orange.
    psx = 280
    d.polygon([(psx, 130), (psx + 24, 130), (psx + 12, 110)], fill=(220, 140, 60, 255))
    d.line([(psx + 12, 130), (psx + 12, 162)], fill=(120, 88, 40, 255), width=2)

    return img


# ---- Scene 6 — Crew Gangway -----------------------------------------

def scene_gangway(t: float) -> Image.Image:
    img = Image.new("RGBA", (W, H), (24, 30, 38, 255))
    d = ImageDraw.Draw(img)

    # Bulkhead wall — cool grey.
    for y in range(H):
        c = mix((52, 60, 70), (28, 32, 40), y / H)
        d.line([(0, y), (W, y)], fill=c + (255,))

    # Floor.
    d.rectangle([0, 150, W, H], fill=(36, 40, 48, 255))
    for x in range(0, W, 10):
        d.line([(x, 150), (x, H)], fill=(28, 32, 38, 255), width=1)

    # Watertight door frame in the centre.
    fx0, fy0, fx1, fy1 = 100, 30, 220, 162
    d.rectangle([fx0 - 4, fy0 - 4, fx1 + 4, fy1 + 4], fill=(70, 76, 84, 255))
    d.rectangle([fx0, fy0, fx1, fy1], fill=(46, 52, 60, 255))
    # Door edges
    d.rectangle([fx0, fy0, fx0 + 6, fy1], fill=(38, 44, 52, 255))
    d.rectangle([fx1 - 6, fy0, fx1, fy1], fill=(38, 44, 52, 255))
    # Big wheel-handle
    cx, cy, r = (fx0 + fx1) // 2, (fy0 + fy1) // 2 - 6, 16
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(160, 170, 180), width=2)
    for i in range(8):
        ang = i * math.pi / 4
        d.line(
            [
                (cx + math.cos(ang) * 4, cy + math.sin(ang) * 4),
                (cx + math.cos(ang) * (r - 1), cy + math.sin(ang) * (r - 1)),
            ],
            fill=(160, 170, 180, 255),
            width=2,
        )
    d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=(120, 130, 140, 255))

    # Caution stripe along the floor at the threshold.
    for x in range(0, W, 14):
        d.polygon(
            [(x, 145), (x + 7, 145), (x + 14, 152), (x + 7, 152)],
            fill=(220, 180, 40, 255),
        )

    # ID card reader — small panel on the right with a blinking LED.
    rdr = (fx1 + 12, 80)
    d.rectangle([rdr[0], rdr[1], rdr[0] + 16, rdr[1] + 24], fill=(28, 32, 40, 255))
    d.rectangle([rdr[0] + 1, rdr[1] + 1, rdr[0] + 15, rdr[1] + 23], outline=(80, 90, 100), width=1)
    led_on = (int(t * FRAMES) % 4) < 2
    d.ellipse(
        [rdr[0] + 6, rdr[1] + 6, rdr[0] + 10, rdr[1] + 10],
        fill=(60, 200, 120, 255) if led_on else (28, 50, 36, 255),
    )

    # Sign above the door.
    d.rectangle([fx0 + 18, fy0 - 14, fx1 - 18, fy0 - 4], fill=(220, 200, 80, 255))
    d.text((fx0 + 28, fy0 - 14), "CREW ONLY", fill=(40, 30, 8, 255))

    # Occasional crew member walking past — bottom third only, alternates
    # direction each loop so it doesn't feel mechanical.
    cycle = (t * 2) % 2
    if 0.2 < cycle < 1.0:
        local_t = (cycle - 0.2) / 0.8
        sx = int(-20 + local_t * (W + 40))
        sy = 168
        d.ellipse([sx - 5, sy - 22, sx + 5, sy - 12], fill=(14, 18, 22, 255))
        d.rectangle([sx - 7, sy - 12, sx + 7, sy + 6], fill=(14, 18, 22, 255))
        leg_phase = math.sin(local_t * 2 * math.pi * 6) * 3
        d.line([(sx - 2, sy + 6), (sx - 2 + leg_phase, sy + 18)], fill=(14, 18, 22, 255), width=2)
        d.line([(sx + 2, sy + 6), (sx + 2 - leg_phase, sy + 18)], fill=(14, 18, 22, 255), width=2)

    return img


# ---- Driver --------------------------------------------------------

SCENES = [
    ("bridge",    scene_bridge),
    ("atrium",    scene_atrium),
    ("engine",    scene_engine),
    ("promenade", scene_promenade),
    ("pooldeck",  scene_pool),
    ("gangway",   scene_gangway),
]


def main() -> None:
    print(f"Generating {len(SCENES)} CCTV loops → {OUT_DIR}")
    for name, fn in SCENES:
        frames: list[Image.Image] = []
        for i in range(FRAMES):
            t = i / FRAMES
            img = fn(t)
            frames.append(finish_frame(img, i))
        save_gif(name, frames)


if __name__ == "__main__":
    main()
