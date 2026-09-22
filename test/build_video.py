#!/usr/bin/env python3
"""
Assemble the Ladder demo: pad each beat to its narration, composite a moving
cursor, burn captions, concat, mux.

The cursor is drawn and composited rather than screen-recorded, because
Page.captureScreenshot never includes the OS pointer. Waypoints are declared per
beat so the pointer is where the narration is pointing.
"""
import json
import os
import subprocess
import sys

OUT = "/tmp/ladder-beats"
VO = "/tmp/ladder-vo/wav2"
W, H = 1440, 900

# name, source clip, cursor waypoints [(t_frac, x, y)] in output pixel space
BEATS = [
    ("01-gate", "01-gate.mp4", []),
    ("02-problem", "02-problem.mp4", []),
    ("03-create", "03-create.mp4", []),
    ("04-ladder", "04-ladder.mp4", []),
    ("05-escalate", "05-escalate.mp4", []),
    ("06-agentmail", "06-agentmail.mp4", []),
    ("07-convex", "07-convex.mp4", []),
    ("08-watch-pack", "08-watch-pack.mp4", []),
    ("09-tests", None, []),  # rendered from the real test output card
]


def dur(path):
    return float(
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True,
        ).stdout.strip()
    )


def cursor_expr(waypoints, length):
    """Piecewise-linear ffmpeg expression for the pointer position."""
    if not waypoints:
        return None, None
    pts = [(f * length, x, y) for f, x, y in waypoints]
    def build(idx):
        expr = str(pts[-1][idx])
        for i in range(len(pts) - 2, -1, -1):
            t0, *_ = pts[i]
            t1 = pts[i + 1][0]
            v0, v1 = pts[i][idx], pts[i + 1][idx]
            span = max(t1 - t0, 0.001)
            seg = f"({v0}+({v1}-{v0})*(t-{t0})/{span})"
            expr = f"if(lt(t,{t1}),{seg},{expr})"
        return expr
    return build(1), build(2)


def main():
    lines = [l.strip() for l in open("/tmp/ladder-vo/lines.txt") if l.strip()]
    srt, concat, cursor = [], [], os.path.join(OUT, "cursor.png")
    clock = 0.0

    for i, (name, src, waypoints) in enumerate(BEATS, start=1):
        wav = f"{VO}/line{i}.wav"
        length = dur(wav)
        out = f"{OUT}/p-{name}.mp4"

        if name in ("01-gate", "02-problem"):
            concat.append(f"file 'p-{name}.mp4'")
            words = lines[i - 1].split()
            chunk, chunks = [], []
            for w in words:
                chunk.append(w)
                if len(" ".join(chunk)) > 46:
                    chunks.append(" ".join(chunk)); chunk = []
            if chunk:
                chunks.append(" ".join(chunk))
            t = clock
            tw = sum(len(c.split()) for c in chunks) or 1
            for c in chunks:
                seg = length * (len(c.split()) / tw)
                srt.append((t, t + seg, c)); t += seg
            clock += length
            continue

        if src is None:
            base = ["-loop", "1", "-i", f"{OUT}/e2e-card.png"]
            vf = (f"scale={W}:{H},setsar=1,fps=30,format=yuv420p")
        else:
            base = ["-i", f"{OUT}/{src}"]
            vf = (
                f"scale={W}:-2,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0xf4f1ea,"
                f"setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=40"
            )

        cmd = ["ffmpeg", "-y", "-loglevel", "error"] + base
        xe, ye = cursor_expr(waypoints, length)
        if xe:
            cmd += ["-i", cursor]
            filt = f"[0:v]{vf}[bg];[bg][1:v]overlay=x='{xe}':y='{ye}':eval=frame[v]"
            cmd += ["-filter_complex", filt, "-map", "[v]"]
        else:
            cmd += ["-vf", vf]
        cmd += ["-t", f"{length}", "-r", "30", "-c:v", "libx264",
                "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", out]
        subprocess.run(cmd, check=True)

        concat.append(f"file 'p-{name}.mp4'")

        # Captions: split the line into short chunks, timed by word share.
        words = lines[i - 1].split()
        chunk, chunks = [], []
        for w in words:
            chunk.append(w)
            if len(" ".join(chunk)) > 46:
                chunks.append(" ".join(chunk)); chunk = []
        if chunk:
            chunks.append(" ".join(chunk))
        t = clock
        total_words = sum(len(c.split()) for c in chunks) or 1
        for c in chunks:
            share = len(c.split()) / total_words
            seg = length * share
            srt.append((t, t + seg, c))
            t += seg
        clock += length

    with open(f"{OUT}/concat.txt", "w") as fh:
        fh.write("\n".join(concat) + "\n")

    def ts(s):
        h = int(s // 3600); m = int((s % 3600) // 60)
        sec = s % 60
        return f"{h:02d}:{m:02d}:{sec:06.3f}".replace(".", ",")

    with open(f"{OUT}/captions.srt", "w") as fh:
        for n, (a, b, text) in enumerate(srt, 1):
            fh.write(f"{n}\n{ts(a)} --> {ts(b)}\n{text}\n\n")

    print(f"beats: {len(BEATS)}  captions: {len(srt)}  total: {clock:.1f}s")


if __name__ == "__main__":
    main()
