#!/usr/bin/env python3
"""合并采集：关键词搜索 + 关注 UP 主新片 → data/candidates.json"""
import os
import asyncio, json, random, re, sys, time, urllib.request
from pathlib import Path
from datetime import datetime, timezone, timedelta

from bilibili_api import search, user, Credential

HERE = Path(os.environ.get("DIGEST_HOME") or Path(__file__).resolve().parent.parent)
DATA = HERE / "data"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      "Referer": "https://www.bilibili.com/"}
TZ = timezone(timedelta(hours=8))
NOW = time.time()

# 关注的 AI / 科技 / 商业 UP（uid 已核对）
UPS = {
    4401694: "林亦LYi", 508452265: "硅谷101", 1741797: "歸藏的AI工具箱", 385670211: "秋芝2046",
    313468110: "数字生命卡兹克", 371846699: "图灵的猫", 73414544: "机器之心", 946974: "影视飓风",
    39089748: "李自然说", 450195232: "泛函", 612932327: "老石谈芯", 673779175: "量子位",
    90183256: "36氪", 478559884: "晚点LatePost", 1406810: "宝玉", 3537113897241540: "木羽Cheney",
}

KEYWORDS = ["AI Agent", "AI 工具", "大模型", "Claude", "ChatGPT", "AI 编程", "AI 视频",
            "AI 变现", "AI 副业", "AI 创业", "AI 产品", "独立开发", "AI 营销", "AI 获客",
            "GEO 优化", "AI 内容创作", "小红书 AI", "AI 自动化", "n8n", "AI 工作流",
            "AI 效率", "AI 教程", "AI 实战", "提示词"]

AI_RE = re.compile(r"(AI|AIGC|Agent|GPT|Claude|Gemini|大模型|智能体|提示词|Sora|ComfyUI|n8n|"
                   r"DeepSeek|Qwen|豆包|Kimi|模型|算力|机器人|具身|自动化)", re.I)
BAD_RE = re.compile(r"(A股|涨停|复盘|考研|听力|高考|彩票|足球|篮球|原神|王者荣耀|基金|币圈|明星|八卦)", re.I)


def cred():
    p = DATA / "anon.json"
    if p.exists():
        d = json.loads(p.read_text())
    else:
        r = json.loads(urllib.request.urlopen(
            urllib.request.Request("https://api.bilibili.com/x/frontend/finger/spi", headers=UA), timeout=10).read())
        d = {"buvid3": r["data"]["b_3"], "buvid4": r["data"]["b_4"]}
        p.write_text(json.dumps(d))
    return Credential(buvid3=d["buvid3"], buvid4=d["buvid4"])


CRED = cred()
OUT = {}


def put(bvid, title, author, play, review, danmaku, dur, pub, desc, src):
    if not bvid:
        return
    r = OUT.setdefault(bvid, {"bvid": bvid, "title": title, "author": author, "play": play,
                              "review": review, "danmaku": danmaku, "duration": dur,
                              "pubdate": pub, "desc": (desc or "")[:180], "src": set()})
    r["src"].add(src)
    r["play"] = max(r["play"], play)


async def retry(fn, n=4):
    for i in range(n):
        try:
            return await fn()
        except Exception as e:
            if i == n - 1:
                print(f"[warn] {type(e).__name__}: {str(e)[:50]}", file=sys.stderr)
                return None
            await asyncio.sleep(3 + i * 4 + random.random())


async def do_search(kw, order, page):
    res = await retry(lambda: search.search_by_type(
        keyword=kw, search_type=search.SearchObjectType.VIDEO, page=page, order_type=order))
    if not res:
        return
    for it in res.get("result") or []:
        title = re.sub(r"<[^>]+>", "", it.get("title") or "")
        put(it.get("bvid"), title, it.get("author"), it.get("play", 0), it.get("review", 0),
            it.get("video_review", 0), it.get("duration"), it.get("pubdate", 0),
            it.get("description") or "", kw)


async def do_feed(uid, name):
    vs = await retry(lambda: user.User(uid=uid, credential=CRED).get_videos(pn=1))
    if not vs:
        return
    for v in (vs.get("list") or {}).get("vlist") or []:
        put(v.get("bvid"), re.sub(r"<[^>]+>", "", v.get("title") or ""), name, v.get("play", 0),
            0, 0, v.get("length"), v.get("created") or 0, v.get("description") or "", "UP关注")


async def main():
    sem = asyncio.Semaphore(2)

    async def s_job(kw, order, page):
        async with sem:
            await asyncio.sleep(random.uniform(0.6, 1.4))
            await do_search(kw, order, page)

    async def f_job(uid, name):
        async with sem:
            await asyncio.sleep(random.uniform(0.6, 1.4))
            await do_feed(uid, name)

    tasks = []
    for kw in KEYWORDS:
        tasks.append(s_job(kw, search.OrderVideo.PUBDATE, 1))
        tasks.append(s_job(kw, search.OrderVideo.CLICK, 1))
    for uid, name in UPS.items():
        tasks.append(f_job(uid, name))
    await asyncio.gather(*tasks)

    rows = []
    for r in OUT.values():
        d = max((NOW - r["pubdate"]) / 86400, 1 / 24) if r["pubdate"] else 99
        if d > 8:
            continue
        vph = r["play"] / (d * 24)
        eng = (r["review"] * 3 + r["danmaku"] * 2) / max(r["play"], 1)
        r["age_days"] = round(d, 2)
        r["vph"] = round(vph, 1)
        r["eng"] = round(eng, 3)
        r["score"] = round(vph ** 0.55 * (1 + min(eng, 2)), 1)
        r["src"] = sorted(r["src"])
        r["url"] = f"https://www.bilibili.com/video/{r['bvid']}"
        rows.append(r)

    # 相关性筛选
    rows = [r for r in rows if (AI_RE.search(r["title"] + " " + r["desc"]) or "UP关注" in r["src"])
            and not BAD_RE.search(r["title"])]
    rows.sort(key=lambda x: -x["score"])
    payload = {"generated_at": datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S"),
               "count": len(rows),
               "d1": sum(1 for r in rows if r["age_days"] <= 1),
               "d3": sum(1 for r in rows if r["age_days"] <= 3),
               "videos": rows}
    (DATA / "candidates.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"total={len(rows)} d1={payload['d1']} d3={payload['d3']}")
    for r in rows[:20]:
        print(f"{r['score']:>7} {r['age_days']:>5}d {r['play']:>8} {r['src'][0][:8]:<8}| {r['title'][:44]} @{r['author']}")


if __name__ == "__main__":
    asyncio.run(main())
