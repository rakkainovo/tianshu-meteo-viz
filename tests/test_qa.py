# -*- coding: utf-8 -*-
"""
test_qa.py —— 问答引擎回归测试

用法：
    python tests/test_qa.py            # 需要后端已在 5178 端口运行
    python tests/test_qa.py --port 5000

设计思路：把"问题 -> 期望命中的意图"固化成用例表，
每次改动解析规则后跑一遍，防止新加的规则把老问题挤掉
（这在规则引擎里是最常见的回归事故）。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request

# (问题, 期望意图)
CASES = [
    # 计数
    ("现在有多少条预警？", "count"),
    ("红色预警有几条？", "count"),
    ("新疆维吾尔自治区有多少条大风预警？", "count"),
    # 排名
    ("哪个省的预警最多？", "rank_province"),
    ("预警数量最多的前5个省份是哪些？", "rank_province"),
    ("哪些城市预警最多？", "rank_city"),
    ("发布预警最多的气象台是哪家？", "rank_issuer"),
    # 筛选
    ("广东省有哪些预警？", "filter_list"),
    ("暴雨预警有哪些？", "filter_list"),
    # 分布
    ("全国的预警等级分布如何？", "level_dist"),
    ("灾种构成是怎样的？", "type_dist"),
    # 趋势
    ("预警数量随时间怎么变化？", "trend"),
    ("哪个时段预警最多？", "trend"),
    # 对比
    ("广东和湖南哪个预警更多？", "compare"),
    # 站点
    ("全国最高气温出现在哪里？", "station_extreme"),
    ("最冷的地方是哪里？", "station_extreme"),
    ("北京市气象站有多少个？", "station_count"),
    ("今天天气怎么样？", "weather_summary"),
    # 台风
    ("最强的台风是哪个？", "typhoon_strongest"),
    ("台风杜鹃的路径是怎样的？", "typhoon_path"),
    # 综合
    ("现在整体形势怎么样？", "overview"),
]


def ask(port: int, q: str) -> dict:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/qa",
        data=json.dumps({"q": q}).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5178)
    a = ap.parse_args()

    passed, failed = 0, []
    for q, expect in CASES:
        try:
            r = ask(a.port, q)
            got = r.get("intent")
            chart = "图" if r.get("chart") else " "
            if got == expect:
                passed += 1
                print(f"  ✓ [{chart}] {q}")
            else:
                failed.append((q, expect, got))
                print(f"  ✗ [{chart}] {q}\n      期望 {expect}，实得 {got}")
        except Exception as e:                                   # noqa: BLE001
            failed.append((q, expect, f"异常 {e}"))
            print(f"  ✗ {q}\n      {e}")

    total = len(CASES)
    print(f"\n意图识别通过 {passed}/{total}（{passed / total * 100:.1f}%）")
    if failed:
        print("\n未通过用例：")
        for q, e, g in failed:
            print(f"  · {q} -> 期望 {e}，实得 {g}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
