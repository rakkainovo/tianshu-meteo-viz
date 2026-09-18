# -*- coding: utf-8 -*-
"""
fetch_geo.py —— 行政区划 GeoJSON 离线缓存

用途：把可视化要用到的地图边界一次性抓到本地，答辩现场断网也能正常渲染。

数据源：阿里 DataV 标准行政区划边界（与自然资源部标准地图审图号一致的大轮廓）

缓存策略（三级下钻）：
    data/geo/100000.json      全国    —— 34 个省级单位 + 南海诸岛
    data/geo/{省adcode}.json  省级    —— 该省下辖各市
    data/geo/c{市adcode}.json 市级    —— 该市下辖区县

用法：
    python fetch_geo.py             # 补齐全量（已存在的跳过）
    python fetch_geo.py --force     # 强制重下
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
GEO_DIR = BASE / "data" / "geo"
DATA_URL = "https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json"

try:
    from curl_cffi import requests as creq
    _SESSION = creq.Session(impersonate="chrome124")
    _GET = lambda url: _SESSION.get(url, timeout=30)
except Exception:  # pragma: no cover
    import requests
    _GET = lambda url: requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})

# 34 个省级行政区（含台湾省、香港、澳门特别行政区）
PROVINCES = [
    110000, 120000, 130000, 140000, 150000, 210000, 220000, 230000, 310000, 320000,
    330000, 340000, 350000, 360000, 370000, 410000, 420000, 430000, 440000, 450000,
    460000, 500000, 510000, 520000, 530000, 540000, 610000, 620000, 630000, 640000,
    650000, 710000, 810000, 820000,
]


def log(msg: str) -> None:
    print(msg, flush=True)


def fetch(adcode: int, out: Path, force: bool) -> int:
    """下载单个行政区划文件，返回下辖单位数量（0 表示失败/跳过）"""
    if out.exists() and not force and out.stat().st_size > 200:
        try:
            import json
            return len(json.loads(out.read_text(encoding="utf-8"))["features"])
        except Exception:
            out.unlink(missing_ok=True)

    url = DATA_URL.format(adcode=adcode)
    for attempt in range(3):
        try:
            r = _GET(url)
            if r.status_code == 404:
                return 0                      # 叶子节点没有下级，无需重试
            if r.status_code == 200 and len(r.content) > 200:
                out.write_bytes(r.content)
                import json
                return len(json.loads(r.content.decode("utf-8"))["features"])
        except Exception:
            pass
        time.sleep(0.8 * (attempt + 1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="强制重新下载")
    args = ap.parse_args()
    GEO_DIR.mkdir(parents=True, exist_ok=True)

    # 1) 全国底图
    n = fetch(100000, GEO_DIR / "100000.json", args.force)
    log(f"[全国] 100000.json -> {n} 个省级单位")

    # 2) 省级（含下辖市）
    city_codes: list[int] = []
    for code in PROVINCES:
        out = GEO_DIR / f"{code}.json"
        cnt = fetch(code, out, args.force)
        log(f"[省级] {code}.json -> {cnt} 个下级")
        if cnt:
            import json
            try:
                d = json.loads(out.read_text(encoding="utf-8"))
                for f in d["features"]:
                    pr = f["properties"]
                    ac = pr.get("adcode")
                    # 省级文件里的要素即为其下辖地级市（adcode 形如 440100），全部纳入
                    if ac and pr.get("level") == "city":
                        city_codes.append(int(ac))
            except Exception:
                pass

    # 3) 市级（含下辖区县）
    city_codes = sorted(set(city_codes))
    log(f"[市级] 待补 {len(city_codes)} 个市")
    ok = 0
    for i, code in enumerate(city_codes, 1):
        out = GEO_DIR / f"c{code}.json"
        if fetch(code, out, args.force):
            ok += 1
        if i % 50 == 0:
            log(f"  进度 {i}/{len(city_codes)}，成功 {ok}")

    total = len(list(GEO_DIR.glob("*.json")))
    size = sum(f.stat().st_size for f in GEO_DIR.glob("*.json")) / 1024 / 1024
    log(f"[完成] 地图文件 {total} 个，合计 {size:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
