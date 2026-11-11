#!/usr/bin/env python3
"""把一份 markdown 日报推到飞书（自定义机器人 · 交互卡片）。

用法:
    python3 push_feishu.py reports/2026-11-11.md
    python3 push_feishu.py reports/2026-11-11.md --dry     # 只打印 payload，不发

webhook 解析顺序:
    1. 环境变量 FEISHU_WEBHOOK
    2. ~/.qq-digest/config.json 的 push.feishu_webhook（复用已有配置）
secret 同理（没有就不签名）。
"""
import json
import os
import re
import sys
import time
import hashlib
import hmac
import base64
import urllib.request
from pathlib import Path

QQ_CFG = Path.home() / ".qq-digest" / "config.json"
MAX_CHUNK = 1800
MAX_PAYLOAD = 28000


def resolve():
    hook = os.environ.get("FEISHU_WEBHOOK", "")
    secret = os.environ.get("FEISHU_SECRET", "")
    if not hook and QQ_CFG.exists():
        try:
            p = json.loads(QQ_CFG.read_text()).get("push", {})
            hook = p.get("feishu_webhook", "")
            secret = secret or p.get("feishu_secret", "")
        except Exception:
            pass
    return hook, secret


def md(text):
    return {"tag": "div", "text": {"tag": "lark_md", "content": text}}


def convert(markdown: str):
    """markdown -> (title, elements[])"""
    lines = markdown.splitlines()
    title = "AI 情报日报"
    out = []
    buf = []

    def flush():
        if buf:
            chunk = "\n".join(buf).strip()
            if chunk:
                out.append(md(chunk))
            buf.clear()

    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        s = line.strip()

        if not s:
            buf.append("")
            i += 1
            continue

        # 一级标题 -> 卡片标题
        if s.startswith("# "):
            title = s[2:].strip()
            i += 1
            continue

        # 分割线
        if s in ("---", "***"):
            flush()
            out.append({"tag": "hr"})
            i += 1
            continue

        # 二级标题
        if s.startswith("## "):
            flush()
            buf.append(f"**{s[3:].strip()}**")
            i += 1
            continue

        # 表格：收集整块
        if s.startswith("|"):
            flush()
            block = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                block.append(lines[i].strip())
                i += 1
            rows = [
                [c.strip() for c in r.strip("|").split("|")]
                for r in block
                if not re.match(r"^\|[\s:\-|]+\|$", r)
            ]
            if rows:
                header = rows[0]
                for r in rows[1:]:
                    cells = [c for c in r if c]
                    if not cells:
                        continue
                    if len(header) > 1 and len(cells) >= 2:
                        buf.append(f"· **{cells[0]}** — {' · '.join(cells[1:])}")
                    else:
                        buf.append(f"· {cells[0]}")
            continue

        # 引用
        if s.startswith(">"):
            flush()
            out.append(md(f"<font color='grey'>{s.lstrip('> ').strip()}</font>"))
            i += 1
            continue

        buf.append(s)
        i += 1

    flush()

    # 切成不超过 MAX_CHUNK 的块
    merged = []
    for el in out:
        if el.get("tag") == "div" and len(el["text"]["content"]) > MAX_CHUNK:
            text = el["text"]["content"]
            for k in range(0, len(text), MAX_CHUNK):
                merged.append(md(text[k : k + MAX_CHUNK]))
        else:
            merged.append(el)
    return title, merged


def sign(secret: str, ts: str) -> str:
    key = f"{ts}\n{secret}".encode()
    return base64.b64encode(hmac.new(key, b"", hashlib.sha256).digest()).decode()


def build_card(title, elements):
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": title[:100]},
            "template": "blue",
        },
        "elements": elements,
    }


def post(hook, payload):
    data = json.dumps(payload, ensure_ascii=False).encode()
    req = urllib.request.Request(
        hook, data=data, headers={"Content-Type": "application/json; charset=utf-8"}
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = Path(sys.argv[1])
    dry = "--dry" in sys.argv
    hook, secret = resolve()
    if not hook:
        print("没有 webhook：设置 FEISHU_WEBHOOK 或配置 ~/.qq-digest/config.json")
        return 2

    title, elements = convert(path.read_text())
    payload = {"msg_type": "interactive", "card": build_card(title, elements)}

    size = len(json.dumps(payload, ensure_ascii=False).encode())
    if size > MAX_PAYLOAD:
        # 太长就砍尾部元素，保留正文主干
        while elements and size > MAX_PAYLOAD:
            elements.pop()
            payload["card"]["elements"] = elements
            size = len(json.dumps(payload, ensure_ascii=False).encode())
        elements.append(md("<font color='grey'>（内容过长已截断，完整版见本地 reports/）</font>"))

    if secret:
        ts = str(int(time.time()))
        payload["timestamp"] = ts
        payload["sign"] = sign(secret, ts)

    print(f"卡片: {len(elements)} 个元素, {size} 字节 -> {hook[:45]}…")
    if dry:
        print(json.dumps(payload, ensure_ascii=False, indent=1)[:1500])
        return 0

    res = post(hook, payload)
    code = res.get("code", res.get("StatusCode"))
    print("结果:", json.dumps(res, ensure_ascii=False))
    return 0 if code in (0, None) else 1


if __name__ == "__main__":
    sys.exit(main())
