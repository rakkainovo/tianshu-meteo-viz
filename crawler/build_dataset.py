# -*- coding: utf-8 -*-
"""
build_dataset.py —— 把采集到的原始数据清洗成前端可直接消费的数据集

做四件事：
  1. 解析预警信号标题 -> 省 / 市 / 县 / 灾种 / 等级（处理自治区、直辖市等特殊情况）
  2. 从阿里 DataV 标准 GeoJSON 提取全国省、市、区县三级中心坐标（本地缓存，按需抓取）
  3. 把预警记录关联到精确坐标，使其能落到地图上
  4. 生成各图表所需的聚合数据集

用法：
    python build_dataset.py                # 全量构建
    python build_dataset.py --refresh-geo  # 强制重抓坐标
    python build_dataset.py --no-geo       # 跳过坐标抓取
"""
from __future__ import annotations

import json
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from curl_cffi import requests as creq

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PROC = ROOT / "data" / "processed"
GEO_CACHE = ROOT / "data" / "geo"
PROC.mkdir(parents=True, exist_ok=True)
GEO_CACHE.mkdir(parents=True, exist_ok=True)

DATAV = "https://geo.datav.aliyun.com/areas_v3/bound/%s_full.json"

LEVEL_RANK = {"蓝色": 1, "黄色": 2, "橙色": 3, "红色": 4}


def log(m):
    print(m, flush=True)


# ==========================================================================
# 一、行政区划名称解析
# ==========================================================================
PROV_ALIAS = {
    "北京": "北京市", "天津": "天津市", "上海": "上海市", "重庆": "重庆市",
    "河北": "河北省", "山西": "山西省", "辽宁": "辽宁省", "吉林": "吉林省",
    "黑龙江": "黑龙江省", "江苏": "江苏省", "浙江": "浙江省", "安徽": "安徽省",
    "福建": "福建省", "江西": "江西省", "山东": "山东省", "河南": "河南省",
    "湖北": "湖北省", "湖南": "湖南省", "广东": "广东省", "海南": "海南省",
    "四川": "四川省", "贵州": "贵州省", "云南": "云南省", "陕西": "陕西省",
    "甘肃": "甘肃省", "青海": "青海省", "台湾": "台湾省",
    "内蒙古": "内蒙古自治区", "广西": "广西壮族自治区",
    "西藏": "西藏自治区", "宁夏": "宁夏回族自治区", "新疆": "新疆维吾尔自治区",
    "香港": "香港特别行政区", "澳门": "澳门特别行政区",
}
MUNICIPALITIES = {"北京市", "天津市", "上海市", "重庆市"}
# 全称优先（长度降序），再退到简称，避免"内蒙古"吃掉"内蒙古自治区"后面的内容
_PROV_FULL = sorted(set(PROV_ALIAS.values()), key=len, reverse=True)
_PROV_SHORT = sorted(PROV_ALIAS.keys(), key=len, reverse=True)
_SUFFIXES = ["特别行政区", "自治区", "自治州", "自治县", "自治旗",
             "地区", "盟", "省", "市", "县", "区", "旗"]

ADM2PROV = {
    "11": "北京市", "12": "天津市", "13": "河北省", "14": "山西省", "15": "内蒙古自治区",
    "21": "辽宁省", "22": "吉林省", "23": "黑龙江省",
    "31": "上海市", "32": "江苏省", "33": "浙江省", "34": "安徽省", "35": "福建省",
    "36": "江西省", "37": "山东省",
    "41": "河南省", "42": "湖北省", "43": "湖南省", "44": "广东省",
    "45": "广西壮族自治区", "46": "海南省",
    "50": "重庆市", "51": "四川省", "52": "贵州省", "53": "云南省", "54": "西藏自治区",
    "61": "陕西省", "62": "甘肃省", "63": "青海省", "64": "宁夏回族自治区",
    "65": "新疆维吾尔自治区",
    "71": "台湾省", "81": "香港特别行政区", "82": "澳门特别行政区",
}


def split_admin(text: str) -> tuple[str, str, str]:
    """
    从发布单位名拆出省 / 市 / 县。
      '江西省吉安市遂川县气象台'                -> (江西省, 吉安市, 遂川县)
      '新疆维吾尔自治区克孜勒苏柯尔克孜自治州阿克陶县气象台'
                                              -> (新疆维吾尔自治区, 克孜勒苏柯尔克孜自治州, 阿克陶县)
      '北京市朝阳区气象台'                      -> (北京市, '', 朝阳区)
    """
    t = re.sub(r"(气象台|气象站|气象局|台)$", "", text.strip())
    t = re.sub(r"气象台.*$", "", t).strip()

    prov = ""
    for p in _PROV_FULL:                       # 先匹配全称
        if t.startswith(p):
            prov, t = p, t[len(p):]
            break
    if not prov:
        for s in _PROV_SHORT:                  # 再匹配简称
            if t.startswith(s):
                prov, t = PROV_ALIAS[s], t[len(s):]
                break

    parts = []
    while t:
        hit = ""
        for suf in _SUFFIXES:
            idx = t.find(suf)
            if idx >= 0:
                hit = t[:idx + len(suf)]
                break
        if not hit:
            parts.append(t)
            break
        parts.append(hit)
        t = t[len(hit):]

    city = county = ""
    if prov in MUNICIPALITIES and parts and parts[0].endswith(("区", "县", "旗")):
        county = parts[0]                      # 直辖市：第一个就是区县
        if len(parts) > 1:
            county = parts[0]
    else:
        if parts:
            city = parts[0]
        if len(parts) > 1:
            county = parts[1]
    return prov, city, county


# ==========================================================================
# 二、地理坐标（从标准 GeoJSON 提取，本地缓存）
# ==========================================================================
def fetch(url: str, cache: Path) -> dict | None:
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    try:
        s = creq.Session(impersonate="chrome124")
        r = s.get(url, timeout=45)
        if r.status_code != 200:
            return None
        d = r.json()
        cache.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        time.sleep(0.25)
        return d
    except Exception:                              # noqa: BLE001
        return None


def _centers(doc: dict) -> list[tuple[str, str, list]]:
    """从 GeoJSON 里抽出 (名称, adcode, 中心坐标)。"""
    out = []
    for f in doc.get("features", []):
        p = f.get("properties", {})
        name = p.get("name") or p.get("NAME")
        ctr = p.get("center") or p.get("centroid") or p.get("cp")
        ac = p.get("adcode")
        if name and isinstance(ctr, list) and len(ctr) >= 2:
            out.append((name, str(ac or ""), ctr[:2]))
    return out


def build_coord_map(refresh: bool = False) -> tuple[dict, dict]:
    """
    返回 (坐标表, 城市名->adcode)
    坐标表层级：省 -> 市 -> 区县（区县按需抓取并由 enrich_districts 补齐）
    """
    cache = GEO_CACHE / "coord_map.json"
    adcache = GEO_CACHE / "city_adcode.json"
    if cache.exists() and adcache.exists() and not refresh:
        return (json.loads(cache.read_text(encoding="utf-8")),
                json.loads(adcache.read_text(encoding="utf-8")))

    log("\n[geo] 构建全国行政区划坐标表 ...")
    coords: dict[str, list] = {}
    city_adcode: dict[str, str] = {}

    cn = fetch(DATAV % "100000", GEO_CACHE / "100000.json")
    prov_codes = []
    if cn:
        for name, ac, ctr in _centers(cn):
            coords[name] = ctr
            if ac.endswith("0000") and ac != "100000":
                prov_codes.append((ac, name))
    log("  省级 %d 个" % len(coords))

    failed = []
    for code, pname in prov_codes:
        d = fetch(DATAV % code, GEO_CACHE / ("%s.json" % code))
        if not d:
            failed.append(pname)
            continue
        for name, ac, ctr in _centers(d):
            coords.setdefault(name, ctr)
            if ac:
                city_adcode[name] = ac
    log("  省 + 市 合计 %d 个坐标点%s"
        % (len(coords), ("（失败：%s）" % "、".join(failed)) if failed else ""))

    cache.write_text(json.dumps(coords, ensure_ascii=False), encoding="utf-8")
    adcache.write_text(json.dumps(city_adcode, ensure_ascii=False), encoding="utf-8")
    return coords, city_adcode


def enrich_districts(coords: dict, city_adcode: dict, needed_cities: set[str]) -> dict:
    """只为预警里实际出现的城市抓区县坐标，避免无谓请求。"""
    todo = [(c, city_adcode[c]) for c in needed_cities if c in city_adcode]
    log("  需补区县精度的城市 %d 个" % len(todo))
    added = 0
    failed = []
    for name, code in todo:
        d = fetch(DATAV % code, GEO_CACHE / ("c%s.json" % code))
        if not d:
            failed.append(name)
            continue
        for dname, _ac, ctr in _centers(d):
            if dname not in coords:
                coords[dname] = ctr
                added += 1
    log("  新增区县坐标 %d 个%s"
        % (added, ("（失败 %d 个城市）" % len(failed)) if failed else ""))
    return coords


def geocode(prov: str, city: str, county: str, coords: dict) -> tuple[list | None, str]:
    for name, lvl in ((county, "county"), (city, "city"), (prov, "province")):
        if name and name in coords:
            return coords[name], lvl
    return None, "none"


# ==========================================================================
# 三、清洗预警
# ==========================================================================
def parse_alarms(coords: dict) -> tuple[list, set]:
    src = RAW / "alarms.json"
    if not src.exists():
        return [], set()
    raw = json.loads(src.read_text(encoding="utf-8"))
    recs, cities = [], set()
    for r in raw["records"]:
        issuer = r.get("issuer") or ""
        prov, city, county = split_admin(issuer)
        adm = r.get("adm_code") or ""
        if not prov and len(adm) >= 2:
            prov = ADM2PROV.get(adm[:2], "")
        if city:
            cities.add(city)
        xy, lvl = geocode(prov, city, county, coords)
        recs.append({
            "id": r.get("alertid"), "time": r.get("issuetime"), "title": r.get("title"),
            "type": r.get("type") or "其他", "level": r.get("level") or "未知",
            "level_rank": LEVEL_RANK.get(r.get("level"), 0),
            "issuer": issuer, "province": prov, "city": city, "county": county,
            "adm_code": adm,
            "lng": xy[0] if xy else None, "lat": xy[1] if xy else None,
            "geo_level": lvl, "icon": r.get("icon"),
            "url": "http://www.nmc.cn" + (r.get("url") or ""),
        })
    return recs, cities


def build_stats(alarms: list, weather: list | None) -> dict:
    by_type = Counter(a["type"] for a in alarms)
    by_level = Counter(a["level"] for a in alarms)
    by_prov = Counter(a["province"] for a in alarms if a["province"])
    type_level = Counter((a["type"], a["level"]) for a in alarms)
    hourly = defaultdict(Counter)
    for a in alarms:
        m = re.match(r"(\d{4})/(\d{2})/(\d{2})\s+(\d{2})", (a.get("time") or "").strip())
        if m:
            hourly["%s-%s-%s %s:00" % m.groups()][a["level"]] += 1
    geo_stat = Counter(a["geo_level"] for a in alarms)
    return {
        "kpi": {
            "alarm_total": len(alarms),
            "province_count": len(by_prov),
            "issuer_count": len({a["issuer"] for a in alarms}),
            "station_total": len(weather or []),
            "city_count": len({a["city"] for a in alarms if a["city"]}),
            "red_orange": sum(v for k, v in by_level.items() if k in ("红色", "橙色")),
            "type_count": len(by_type),
        },
        "by_type": by_type.most_common(),
        "by_level": by_level.most_common(),
        "by_province": by_prov.most_common(),
        "type_level": [{"type": k[0], "level": k[1], "count": v}
                       for k, v in type_level.most_common()],
        "hourly": [{"hour": h, **dict(c)} for h, c in sorted(hourly.items())],
        "geo_precision": dict(geo_stat),
    }


def sanitize_station(r: dict) -> dict:
    """清洗单站实况。

    中国气象局接口在"无观测值"时返回哨兵常量 9999，
    它会被误当作真实观测（曾导致"降水 9999mm""湿度 9999%"这类离谱值），
    这里统一还原为 None，并规范天气现象字段。
    """
    out = dict(r)
    for k in ("temp", "feelst", "humidity", "pressure", "rain", "rcomfort", "icomfort"):
        v = out.get(k)
        if isinstance(v, (int, float)) and (v == 9999 or v == 9999.0 or v == -9999):
            out[k] = None
        elif isinstance(v, str):
            out[k] = None
    # 合理区间校验：越界值同样判为缺测
    rng = {"temp": (-60, 60), "feelst": (-70, 70), "humidity": (0, 100),
           "pressure": (500, 1100), "rain": (0, 2000), "rcomfort": (0, 100)}
    for k, (lo, hi) in rng.items():
        v = out.get(k)
        if isinstance(v, (int, float)) and not (lo <= v <= hi):
            out[k] = None
    if not out.get("info") or out["info"].strip() in ("-", "--", ""):
        out["info"] = "未知"
    return out


def build_weather_pack() -> dict:
    src = RAW / "weather_snapshot.json"
    if not src.exists():
        return {}
    raw = json.loads(src.read_text(encoding="utf-8"))
    rows = [sanitize_station(r) for r in raw["stations"]]
    temps = [r["temp"] for r in rows if isinstance(r.get("temp"), (int, float))]
    return {"collected_at": raw["collected_at"], "source": raw["source"],
            "count": len(rows), "stations": rows,
            "temp_range": [min(temps), max(temps)] if temps else None}


# ==========================================================================
def main() -> None:
    t0 = time.time()
    log("=" * 68)
    log(" 数据集构建  |  %s" % datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    log("=" * 68)

    no_geo = "--no-geo" in sys.argv
    refresh = "--refresh-geo" in sys.argv
    if no_geo:
        coords, city_adcode = {}, {}
    else:
        coords, city_adcode = build_coord_map(refresh=refresh)

    log("\n[1/4] 解析预警并匹配坐标 ...")
    recs, cities = parse_alarms(coords)
    log("  预警 %d 条，坐标未匹配 %d 条" % (len(recs), sum(1 for r in recs if r["lng"] is None)))

    if not no_geo and cities:
        log("\n[2/4] 补全区县级坐标 ...")
        before = sum(1 for r in recs if r["geo_level"] == "county")
        coords = enrich_districts(coords, city_adcode, cities)
        recs, _ = parse_alarms(coords)                # 用更精确的坐标重算
        after = sum(1 for r in recs if r["geo_level"] == "county")
        log("  区县级精度：%d -> %d 条" % (before, after))
        (GEO_CACHE / "coord_map.json").write_text(
            json.dumps(coords, ensure_ascii=False), encoding="utf-8")
    else:
        log("\n[2/4] 跳过区县坐标补全")

    log("\n[3/4] 打包站点数据 ...")
    wp = build_weather_pack()
    if wp:
        (PROC / "weather.json").write_text(json.dumps(wp, ensure_ascii=False), encoding="utf-8")
        log("  站点 %d 条，温度区间 %s" % (wp["count"], wp["temp_range"]))
    else:
        log("  尚无实况快照，跳过")

    log("\n[4/4] 生成聚合统计并落盘 ...")
    if recs:
        (PROC / "alarms.json").write_text(json.dumps(
            {"source": "中国气象局 nmc.cn /rest/findAlarm", "count": len(recs),
             "records": recs}, ensure_ascii=False), encoding="utf-8")
        st = build_stats(recs, wp.get("stations"))
        (PROC / "stats.json").write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
        k = st["kpi"]
        log("  预警 %d | 省份 %d | 城市 %d | 发布单位 %d | 灾种 %d | 橙红 %d"
            % (k["alarm_total"], k["province_count"], k["city_count"],
               k["issuer_count"], k["type_count"], k["red_orange"]))
        log("  灾种 TOP5: %s" % st["by_type"][:5])
        log("  等级分布 : %s" % st["by_level"])
        log("  省份 TOP5: %s" % st["by_province"][:5])
        log("  坐标精度 : %s" % st["geo_precision"])

    tp = RAW / "typhoons.json"
    if tp.exists():
        t = json.loads(tp.read_text(encoding="utf-8"))
        (PROC / "typhoons.json").write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
        log("  台风 %d 个 / %d 路径点" % (t["count"], sum(len(x["path"]) for x in t["typhoons"])))

    sp = RAW / "stations.json"
    if sp.exists():
        s = json.loads(sp.read_text(encoding="utf-8"))
        (PROC / "stations.json").write_text(json.dumps(
            {"count": s["station_count"], "stations": [
                {"code": x["code"], "province": x.get("province"), "city": x.get("city")}
                for x in s["stations"]]}, ensure_ascii=False), encoding="utf-8")

    log("\n完成，用时 %.1fs -> %s" % (time.time() - t0, PROC.resolve()))


if __name__ == "__main__":
    main()
