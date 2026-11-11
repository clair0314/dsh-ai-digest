#!/usr/bin/env python3
"""给选中的候选补料：简介/标签/点赞/高赞评论。用法: enrich.py BV1 BV2 ..."""
import os
import asyncio, json, sys, urllib.request, urllib.parse
from pathlib import Path

HERE = Path(os.environ.get("DIGEST_HOME") or Path(__file__).resolve().parent.parent)
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      "Referer": "https://www.bilibili.com/"}


def get(url, times=3):
    last = None
    for _ in range(times):
        try:
            return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=12).read())
        except Exception as e:
            last = e
    return {"code": -1, "err": str(last)}


def one(bvid, ncom=4):
    j = get(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}")
    if j.get("code") != 0:
        return {"bvid": bvid, "error": j.get("code")}
    d = j["data"]
    aid = d["aid"]
    c = get(f"https://api.bilibili.com/x/v2/reply?type=1&oid={aid}&sort=2&ps={ncom}")
    cmts = []
    for r in ((c.get("data") or {}).get("replies") or [])[:ncom]:
        cmts.append({"t": r["content"]["message"][:110], "like": r["like"]})
    return {"bvid": bvid, "title": d["title"], "author": d["owner"]["name"],
            "play": d["stat"]["view"], "like": d["stat"]["like"], "coin": d["stat"]["coin"],
            "fav": d["stat"]["favorite"], "reply": d["stat"]["reply"], "danmaku": d["stat"]["danmaku"],
            "duration": d["duration"], "pubdate": d.get("pubdate") or d.get("pubtime") or 0,
            "tname": d.get("tname"), "desc": (d.get("desc") or "")[:300],
            "tags": [t["tag_name"] for t in (d.get("tags") or [])][:8] if False else [],
            "comments": cmts}


if __name__ == "__main__":
    out = []
    for bv in sys.argv[1:]:
        r = one(bv)
        out.append(r)
        if r.get("error"):
            print(f"!! {bv} err={r['error']}")
            continue
        print(f'\n### {r["title"]}  [{bv}]')
        print(f'  {r["author"]} | 播放{r["play"]} 赞{r["like"]} 币{r["coin"]} 藏{r["fav"]} 评{r["reply"]} | {r["duration"]}s | {r["tname"]}')
        if r["desc"]:
            print("  简介:", r["desc"].replace("\n", " ")[:200])
        for cm in r["comments"]:
            print(f'  💬({cm["like"]}) {cm["t"].replace(chr(10)," ")}')
    (HERE / "data" / "enriched.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
