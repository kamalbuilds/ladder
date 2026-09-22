#!/usr/bin/env python3
"""
Renders the two opening beats as motion graphics.

Beat 1 explains what Ladder does as a three-step mechanic.
Beat 2 tells the real case, including WHY the money was owed, with a mocked-up
airline email so the viewer sees the thing being described.

Drawn with PIL: this ffmpeg build has neither drawtext nor libass.
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1440, 900
FPS = 30
PAPER = (244, 241, 234)
WHITE = (255, 255, 255)
INK = (18, 19, 26)
DIM = (107, 101, 88)
RULE = (214, 208, 194)
LIVE = (31, 111, 74)
OVER = (168, 50, 31)
AMBER = (138, 106, 18)

SER = "/System/Library/Fonts/Supplemental/Georgia.ttf"
MON = "/System/Library/Fonts/SFNSMono.ttf"


def f(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


H1, H2, H3 = f(SER, 54), f(SER, 36), f(SER, 27)
MB, MS, MT = f(MON, 25), f(MON, 20), f(MON, 17)
HUGE = f(SER, 104)


def ease(t):
    return t * t * (3 - 2 * t)


def cl(v, a=0.0, b=1.0):
    return max(a, min(b, v))


def ctr(d, text, fo, y, fill):
    b = d.textbbox((0, 0), text, font=fo)
    d.text(((W - (b[2] - b[0])) // 2, y), text, font=fo, fill=fill)


def chrome(d, kicker):
    d.line([(96, 112), (W - 96, 112)], fill=INK, width=2)
    d.text((96, 62), kicker, font=MS, fill=DIM)


def step_box(d, x, y, w, h, title, body, accent, alpha=1.0):
    if alpha <= 0:
        return
    d.rounded_rectangle([x, y, x + w, y + h], radius=10, fill=WHITE, outline=RULE, width=2)
    d.rectangle([x, y, x + 6, y + h], fill=accent)
    d.text((x + 26, y + 24), title, font=H3, fill=INK)
    yy = y + 70
    for ln in body:
        d.text((x + 26, yy), ln, font=MT, fill=DIM)
        yy += 26


def arrow(d, x0, y, x1, colour=RULE):
    d.line([x0, y, x1 - 12, y], fill=colour, width=3)
    d.polygon([(x1, y), (x1 - 14, y - 8), (x1 - 14, y + 8)], fill=colour)


# ---------------------------------------------------------------- beat 1
def beat1(t, total):
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    chrome(d, "WHAT LADDER DOES")
    ctr(d, "A company has stopped replying to you.", H2, 168, INK)

    bw, bh, gap = 392, 320, 36
    x0 = (W - (bw * 3 + gap * 2)) // 2
    y = 300
    steps = [
        ("1  You name them", ["The letting agent.", "The airline.", "The council.",
                              "", "That is the whole input."], INK),
        ("2  FIRECRAWL crawls", ["their own complaints page,", "then the regulator's.",
                                 "", "OPENAI turns what it read",
                                 "into an ordered ladder, with",
                                 "the deadline they published."], LIVE),
        ("3  CONVEX holds the clock", ["a cron sweeps every", "expired window.", "",
                                       "AGENTMAIL sends the", "escalation, and reads",
                                       "the replies that come back."], OVER),
    ]
    for i, (title, body, accent) in enumerate(steps):
        appear = cl((t - 2.6 - i * 4.4) / 0.8)
        if appear <= 0:
            continue
        x = x0 + i * (bw + gap)
        off = int((1 - ease(appear)) * 26)
        step_box(d, x, y + off, bw, bh, title, body, accent)
        if i > 0 and appear > 0.5:
            arrow(d, x - gap + 6, y + bh // 2, x - 8)

    if t > 18.0:
        ctr(d, "Every deadline links to the page it was read from.", MS, 690, DIM)
    if t > 21.0:
        ctr(d, "Not legal advice. Their own published rules, on time.", MT, 736, DIM)
    return img


# ---------------------------------------------------------------- beat 2
def email_card(d, x, y, w, reveal):
    """
    A representative airline confirmation, so the viewer sees the document being
    described rather than hearing a number read out.

    Every line is measured against the card width before it is drawn, because the
    emphasised line uses a larger face and previously ran past the right border.
    """
    h = 282
    d.rounded_rectangle([x, y, x + w, y + h], radius=10, fill=WHITE, outline=RULE, width=2)
    d.rectangle([x, y, x + w, y + 46], fill=(247, 245, 240))
    d.line([x, y + 46, x + w, y + 46], fill=RULE, width=2)
    d.text((x + 20, y + 14), "Customer Relations", font=MS, fill=INK)
    d.text((x + w - 152, y + 15), "14 July", font=MT, fill=DIM)

    body = [
        ("Dear Mr Adeyemi,", False),
        ("", False),
        ("Following your claim for flight AA101 on 10 July,", False),
        ("we can confirm you are eligible for compensation", False),
        ("of GBP 520.00 under UK air passenger rights.", True),
        ("", False),
        ("Please reply with your bank details to proceed.", False),
    ]
    shown = int(len(body) * ease(cl(reveal)))
    yy = y + 64
    inner = w - 40
    for text, strong in body[:shown]:
        fo = MB if strong else MT
        # Shrink rather than overflow: measure, then step the face down until it fits.
        if text:
            size = 25 if strong else 17
            while size > 12:
                fo = f(MON, size)
                if d.textbbox((0, 0), text, font=fo)[2] <= inner:
                    break
                size -= 1
        d.text((x + 20, yy), text, font=fo, fill=INK if strong else DIM)
        yy += 32 if strong else 27


def beat2(t, total):
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    chrome(d, "A REAL CASE")

    # 0-7s: why the money is owed
    if t < 7.4:
        ctr(d, "A flight is delayed seven hours.", H2, 176, INK)
        p = ease(cl((t - 0.9) / 2.2))
        x0, x1, y = 300, 1140, 330
        d.line([x0, y, x1, y], fill=RULE, width=3)
        for lab, px in (("London", x0), ("New York", x1)):
            d.ellipse([px - 7, y - 7, px + 7, y + 7], fill=INK)
            b = d.textbbox((0, 0), lab, font=MT)
            d.text((px - (b[2] - b[0]) // 2, y + 22), lab, font=MT, fill=DIM)
        px = x0 + (x1 - x0) * p
        d.polygon([(px, y - 12), (px - 18, y + 8), (px + 18, y + 8)], fill=OVER)
        if t > 3.1:
            ctr(d, "+7h", HUGE, 400, OVER)
            ctr(d, "UK air passenger rules entitle him to compensation", MS, 540, DIM)

    # 7.4-16s: the airline confirms it in writing
    elif t < 16.4:
        s = t - 7.4
        ctr(d, "The airline confirms it. In writing.", H2, 176, INK)
        email_card(d, 400, 250, 640, cl(s / 3.0))
        if s > 4.4:
            ctr(d, "He replies with his bank details, exactly as asked.", MS, 578, DIM)

    # 16.4-27s: silence, and the clock
    elif t < 27.0:
        s = t - 16.4
        ctr(d, "Then nothing.", H2, 176, INK)
        months = min(3, int(s / 1.5) + 1)
        ctr(d, f"{months}", HUGE, 246, OVER)
        ctr(d, "months of silence", MS, 392, DIM)
        rows = [("sent bank details", True), ("chased once", True),
                ("chased twice", s > 4.0), ("chased three times", s > 5.6)]
        yy = 456
        for lab, on in rows:
            if not on:
                continue
            d.rounded_rectangle([470, yy, 970, yy + 40], radius=6, fill=WHITE, outline=RULE, width=2)
            d.text((490, yy + 10), lab, font=MT, fill=DIM)
            d.text((880, yy + 10), "no reply", font=MT, fill=OVER)
            yy += 50

    # 27s-end: the actual cause, and the running clock
    else:
        s = t - 27.0
        ctr(d, "The address they gave him was not the desk that pays.", H2, 186, INK)
        if s > 1.6:
            d.rounded_rectangle([320, 300, 1120, 372], radius=8, fill=WHITE, outline=RULE, width=2)
            d.text((350, 322), "customer.relations@  ", font=MB, fill=DIM)
            d.text((640, 322), "the desk that pays", font=MB, fill=LIVE)
            d.line([350, 340, 620, 340], fill=OVER, width=3)
        if s > 3.4:
            ctr(d, "And nobody tells you which one is which.", MS, 432, DIM)
        if s > 5.0:
            p = ease(cl((s - 5.0) / 3.0))
            x0, x1, y = 320, 1120, 560
            d.rounded_rectangle([x0, y, x1, y + 54], radius=6, outline=RULE, width=3)
            d.rounded_rectangle([x0, y, x0 + (x1 - x0) * p, y + 54], radius=6,
                                fill=OVER if p > 0.8 else AMBER)
            d.text((x0, y - 34), "the window you could still escalate in", font=MT, fill=DIM)
            if p > 0.92:
                ctr(d, "running out, quietly", MS, 640, OVER)
    return img


def render(fn, seconds, out_name, tag):
    d = f"/tmp/ladder-beats/{tag}"
    os.makedirs(d, exist_ok=True)
    for x in os.listdir(d):
        os.remove(os.path.join(d, x))
    n = int(seconds * FPS)
    for i in range(n):
        fn(i / FPS, seconds).save(f"{d}/a{i:05d}.png")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS),
         "-i", f"{d}/a%05d.png", "-vf", "format=yuv420p", "-r", "30",
         "-c:v", "libx264", "-preset", "medium", "-crf", "20",
         f"/tmp/ladder-beats/{out_name}"], check=True)
    print(f"{out_name}: {n} frames")


if __name__ == "__main__":
    render(beat1, float(sys.argv[1]), "p-01-gate.mp4", "anim1")
    render(beat2, float(sys.argv[2]), "p-02-problem.mp4", "anim2")
