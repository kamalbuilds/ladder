#!/usr/bin/env python3
"""
Record one demo beat straight from the browser viewport over CDP.

Why not a screen recorder: the machine has personal windows open (mail, chat,
trading) and a shared Brave bundle, so any screen- or window-scoped capture risks
putting them in the frame. Page.startScreencast reads frames from the tab itself,
so nothing outside the page can ever appear.

Usage:
  record_beat.py <name> <seconds> <actions.json>

actions.json is a list of steps, each executed on a wall clock while frames stream:
  {"at": 0.5, "js": "..."}            evaluate JS in the page
  {"at": 2.0, "scroll": 600}          smooth-scroll to y
  {"at": 3.0, "click": "EVIDENCE"}    click first button whose text matches
  {"at": 4.0, "type": "#sel|text"}    set a react-controlled input's value
"""
import base64
import json
import os
import subprocess
import sys
import threading
import time

from websocket import create_connection

PORT = os.environ.get("LADDER_CDP_PORT", "9396")
OUT = "/tmp/ladder-beats"


def find_target(match="convex.site"):
    import urllib.request

    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=10) as r:
        for t in json.load(r):
            if t.get("type") == "page" and match in (t.get("url") or ""):
                return t["id"]
    raise SystemExit(f"no page target matching {match}")


class Page:
    def __init__(self, tid):
        self.ws = create_connection(
            f"ws://127.0.0.1:{PORT}/devtools/page/{tid}",
            timeout=60,
            suppress_origin=True,
            max_size=64 * 1024 * 1024,
        )
        self._id = 0
        self._lock = threading.Lock()

    def send(self, method, params=None):
        with self._lock:
            self._id += 1
            mid = self._id
            self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        return mid

    def evaluate(self, expr):
        self.send("Runtime.evaluate", {"expression": expr, "awaitPromise": True})


JS_CLICK = """(()=>{const t=[...document.querySelectorAll('button')]
  .find(b=>new RegExp(%s,'i').test(b.textContent));
  if(t){t.scrollIntoView({block:'center',behavior:'smooth'});t.click();return 'ok'}return 'miss'})()"""

JS_TYPE = """(()=>{const el=document.querySelector(%s);if(!el)return 'miss';
  const proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement:window.HTMLInputElement;
  const set=Object.getOwnPropertyDescriptor(proto.prototype,'value').set;
  const v=%s;let i=0;
  const tick=()=>{i++;set.call(el,v.slice(0,i));
    el.dispatchEvent(new Event('input',{bubbles:true}));
    if(i<v.length)setTimeout(tick,28)};
  el.focus();tick();return 'ok'})()"""


def main():
    name, seconds, actions_path = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    match = sys.argv[4] if len(sys.argv) > 4 else "convex.site"
    actions = json.load(open(actions_path))
    frames_dir = f"{OUT}/{name}"
    os.makedirs(frames_dir, exist_ok=True)
    for f in os.listdir(frames_dir):
        os.remove(os.path.join(frames_dir, f))

    page = Page(find_target(match))
    page.send("Page.enable")
    # Screencast only emits frames while the tab is actually rendering, so a
    # backgrounded tab produces nothing at all.
    page.send("Page.bringToFront")
    time.sleep(1.0)
    # Page.startScreencast emits nothing when macOS considers the window occluded,
    # which happens constantly on a machine with other apps in front. Polling
    # Page.captureScreenshot works regardless of occlusion, so the capture is
    # deterministic rather than dependent on what else is on screen.
    FPS = 5.0
    start = time.time()
    pending = sorted(actions, key=lambda a: a["at"])
    count = 0
    stamps = []

    while True:
        now = time.time() - start
        if now >= seconds:
            break

        while pending and pending[0]["at"] <= now:
            a = pending.pop(0)
            if "js" in a:
                page.evaluate(a["js"])
            elif "scroll" in a:
                page.evaluate(f"window.scrollTo({{top:{a['scroll']},behavior:'smooth'}})")
            elif "click" in a:
                page.evaluate(JS_CLICK % json.dumps(a["click"]))
            elif "type" in a:
                sel, text = a["type"].split("|", 1)
                page.evaluate(JS_TYPE % (json.dumps(sel), json.dumps(text)))

        mid = page.send("Page.captureScreenshot", {"format": "png", "quality": 92})
        data = None
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                msg = json.loads(page.ws.recv())
            except Exception:
                break
            if msg.get("id") == mid:
                data = (msg.get("result") or {}).get("data")
                break
        if not data:
            continue

        with open(f"{frames_dir}/f{count:05d}.png", "wb") as fh:
            fh.write(base64.b64decode(data))
        stamps.append(now)
        count += 1

        slack = (1.0 / FPS) - ((time.time() - start) - now)
        if slack > 0:
            time.sleep(slack)

    page.ws.close()

    if count == 0:
        raise SystemExit(f"{name}: no frames captured")

    out_mp4 = f"{OUT}/{name}.mp4"

    # Screencast emits only on visual change, so frames are unevenly spaced. Encoding
    # them at a fixed input framerate would compress a 25s beat into two seconds.
    # A concat manifest with real per-frame durations preserves the actual timing.
    manifest = f"{frames_dir}/manifest.txt"
    with open(manifest, "w") as fh:
        for i, t in enumerate(stamps):
            nxt = stamps[i + 1] if i + 1 < len(stamps) else seconds
            fh.write(f"file 'f{i:05d}.png'\nduration {max(nxt - t, 0.02):.3f}\n")
        fh.write(f"file 'f{len(stamps)-1:05d}.png'\n")

    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", manifest,
            "-vf", "scale=1440:-2,fps=30,format=yuv420p",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-t", str(seconds),
            out_mp4,
        ],
        check=True,
    )
    dur = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", out_mp4],
        capture_output=True, text=True,
    ).stdout.strip()
    print(f"{name}: {count} frames -> {out_mp4} ({dur}s, target {seconds}s)")


if __name__ == "__main__":
    main()
