#!/usr/bin/env python3
"""
Renders the opening problem explainer as motion graphics.

Four scenes, matched to the narration: a complaint is sent, nothing comes back,
the published window slides past, and you still do not know who is above them.
Drawn frame by frame with PIL because this ffmpeg build has neither drawtext nor
libass.
"""
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1440, 900
FPS = 30
PAPER = (244, 241, 234)
INK = (18, 19, 26)
DIM = (107, 101, 88)
RULE = (216, 210, 196)
LIVE = (31, 111, 74)
OVER = (168, 50, 31)
OUT = "/tmp/ladder-beats/anim"

F = "/System/Library/Fonts/Supplemental/Georgia.ttf"
M = "/System/Library/Fonts/SFNSMono.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


BIG = font(F, 64)
MID = font(F, 38)
SMALL = font(M, 22)
TINY = font(M, 18)
NUM = font(F, 120)


def ease(t):
    return t * t * (3 - 2 * t)


def clamp(v, a=0.0, b=1.0):
    return max(a, min(b, v))


def centre(d, text, f, y, fill):
    b = d.textbbox((0, 0), text, font=f)
    d.text(((W - (b[2] - b[0])) // 2, y), text, font=f, fill=fill)


def envelope(d, x, y, w=74, h=50, colour=INK):
    d.rounded_rectangle([x, y, x + w, y + h], radius=5, outline=colour, width=3)
    d.line([x + 3, y + 4, x + w / 2, y + h * 0.62, x + w - 3, y + 4], fill=colour, width=3)


def building(d, x, y, colour=INK, label=None):
    d.rectangle([x, y, x + 120, y + 130], outline=colour, width=3)
    for r in range(3):
        for c in range(3):
            d.rectangle(
                [x + 18 + c * 32, y + 20 + r * 34, x + 34 + c * 32, y + 40 + r * 34],
                outline=colour, width=2,
            )
    if label:
        b = d.textbbox((0, 0), label, font=TINY)
        d.text((x + 60 - (b[2] - b[0]) // 2, y + 142), label, font=TINY, fill=DIM)


def frame(t, total):
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    d.line([(110, 118), (W - 110, 118)], fill=INK, width=2)
    d.text((110, 62), "THE PROBLEM", font=SMALL, fill=DIM)

    # Scene A: the complaint goes out.
    if t < 5.6:
        p = ease(clamp(t / 3.4))
        centre(d, "You put the complaint in writing.", MID, 200, INK)
        x = 250 + p * 720
        envelope(d, x, 470)
        building(d, 1080, 430, INK, "the company")
        if t > 1.2:
            centre(d, "6 January  ·  photos attached  ·  the act cited", SMALL, 580, DIM)
        if p >= 1:
            d.ellipse([1080 - 8, 480, 1096, 496], fill=LIVE)

    # Scene B: nothing comes back, weeks tick by.
    elif t < 11.4:
        s = t - 5.6
        centre(d, "Nothing comes back.", MID, 200, INK)
        weeks = min(6, int(s / 0.85))
        centre(d, str(weeks), NUM, 300, OVER if weeks >= 4 else INK)
        centre(d, "weeks of silence", SMALL, 452, DIM)
        # reply counter
        centre(d, "replies received: 0", SMALL, 500, DIM)
        for i in range(6):
            x = 470 + i * 84
            filled = i < weeks
            d.rounded_rectangle([x, 580, x + 62, 612], radius=4,
                                outline=OVER if filled else RULE, width=3,
                                fill=(255, 246, 244) if filled else None)
        if s > 3.2:
            centre(d, "three chases, no answer", SMALL, 664, OVER)

    # Scene C: the published window slides past.
    elif t < 17.0:
        s = t - 11.4
        p = ease(clamp(s / 3.6))
        centre(d, "Their own published window runs out.", MID, 200, INK)
        x0, x1, y = 250, W - 250, 420
        d.rounded_rectangle([x0, y, x1, y + 58], radius=6, outline=RULE, width=3)
        fillw = (x1 - x0) * p
        col = OVER if p > 0.82 else LIVE
        d.rounded_rectangle([x0, y, x0 + fillw, y + 58], radius=6, fill=col)
        d.text((x0, y - 38), "15 working days", font=SMALL, fill=DIM)
        d.text((x1 - 92, y - 38), "deadline", font=SMALL, fill=DIM)
        if p > 0.9:
            centre(d, "PASSED", BIG, 540, OVER)
            centre(d, "and nobody tells you", SMALL, 630, DIM)

    # Scene D: you still do not know who is above them.
    else:
        s = t - 17.0
        centre(d, "And who is above them?", MID, 200, INK)
        labels = ["the council?", "an ombudsman?", "a regulator?"]
        for i, lab in enumerate(labels):
            appear = clamp((s - i * 0.55) / 0.5)
            if appear <= 0:
                continue
            x = 250 + i * 320
            y = 380 + (1 - ease(appear)) * 26
            d.rounded_rectangle([x, y, x + 260, y + 150], radius=8,
                                outline=RULE, width=3)
            b = d.textbbox((0, 0), "?", font=BIG)
            d.text((x + 130 - (b[2] - b[0]) // 2, y + 26), "?", font=BIG, fill=RULE)
            b = d.textbbox((0, 0), lab, font=SMALL)
            d.text((x + 130 - (b[2] - b[0]) // 2, y + 108), lab, font=SMALL, fill=DIM)
        if s > 2.4:
            centre(d, "Guess wrong and the clock keeps running.", SMALL, 620, OVER)

    return img


def main():
    seconds = float(sys.argv[1])
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        os.remove(os.path.join(OUT, f))
    n = int(seconds * FPS)
    for i in range(n):
        frame(i / FPS, seconds).save(f"{OUT}/a{i:05d}.png")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS),
         "-i", f"{OUT}/a%05d.png", "-vf", "format=yuv420p", "-r", "30",
         "-c:v", "libx264", "-preset", "medium", "-crf", "20",
         "/tmp/ladder-beats/p-02-problem.mp4"], check=True)
    print(f"problem animation: {n} frames -> p-02-problem.mp4")


if __name__ == "__main__":
    main()
