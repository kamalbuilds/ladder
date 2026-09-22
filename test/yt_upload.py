#!/usr/bin/env python3
"""Upload the demo to YouTube through the already signed-in browser."""
import json
import sys
import time
import urllib.request

from websocket import create_connection

PORT = "9396"
FILE = "/Users/kamal/Desktop/convex/docs/ladder-demo.mp4"


def page(match):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=10) as r:
        for t in json.load(r):
            if t.get("type") == "page" and match in (t.get("url") or ""):
                return t["id"]
    return None


class C:
    def __init__(self, tid):
        self.ws = create_connection(
            f"ws://127.0.0.1:{PORT}/devtools/page/{tid}",
            timeout=90, suppress_origin=True, max_size=64 * 1024 * 1024,
        )
        self.i = 0

    def send(self, m, p=None):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": m, "params": p or {}}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("id") == self.i:
                return r

    def js(self, expr):
        r = self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        return (r.get("result", {}).get("result") or {}).get("value")


def file_inputs(c):
    doc = c.send("DOM.getDocument", {"depth": -1, "pierce": True})
    found = []

    def walk(n):
        if n.get("nodeName") == "INPUT":
            a = n.get("attributes") or []
            d = dict(zip(a[0::2], a[1::2]))
            if d.get("type") == "file":
                found.append(n["nodeId"])
        for ch in n.get("children") or []:
            walk(ch)
        if n.get("contentDocument"):
            walk(n["contentDocument"])
        for s in n.get("shadowRoots") or []:
            walk(s)

    walk(doc["result"]["root"])
    return found


def main():
    tid = page("youtube.com")
    if not tid:
        sys.exit("no youtube tab")
    c = C(tid)
    c.send("DOM.enable")
    c.send("Runtime.enable")

    if "upload" not in (c.js("location.href") or ""):
        c.js("location.href='https://studio.youtube.com/channel/UCehOv1Aax7rcDBhTWeiimBg/videos/upload?d=ud'")
        time.sleep(6)
    print("clicking create:", c.js(
        "(()=>{const b=document.querySelector('ytcp-button#create-icon')||"
        "document.querySelector('#create-icon');"
        "if(b){b.click();return 'ok'}return 'none'})()"
    ))
    time.sleep(2.5)

    print("choosing upload:", c.js(
        "(()=>{const xs=[...document.querySelectorAll('tp-yt-paper-item')];"
        "const it=xs.find(x=>/upload/i.test(x.textContent||''));"
        "if(it){it.click();return 'ok'}return 'none:'+xs.length})()"
    ))
    time.sleep(4)

    ids = file_inputs(c)
    print("file inputs:", len(ids))
    if not ids:
        sys.exit("no file input found")

    c.send("DOM.setFileInputFiles", {"files": [FILE], "nodeId": ids[0]})
    print("file attached, waiting for processing")
    time.sleep(25)
    print("dialog text:", (c.js("document.body.innerText") or "")[:300].replace("\n", " | "))
    c.ws.close()


if __name__ == "__main__":
    main()
