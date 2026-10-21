# -*- coding: utf-8 -*-
"""
live.py —— 实时数据引擎（天枢平台的"数据心跳"）

设计目标
--------
把"一次性静态数据集"变成"持续生长的数据流"。三个后台任务线程各自按节奏访问
中国气象局公开接口，把新数据**增量**写进 SQLite，并通过 SSE 把变更推给前端。

    任务        节奏            策略
    ------------------------------------------------------------------
    预警信号     60 s            全量拉取分页 → 按 alertid 去重 → 只插新增
    站点实况     30 s / 400 站   "最久未刷新优先"轮转，约 7 分钟覆盖全国 2528 站
    台风路径     30 min          路径与强度全量覆盖写（路径只会变长）

为什么实况要轮转而不是每次全量
------------------------------
一次全量扫 2528 个站点约 5 分钟、2528 次请求，如果每分钟都全量扫，等于 24 h 不
间断高频请求对方服务器 —— 既不礼貌也没必要。改成"每 30 秒刷新最久未更新的 400 站"，
请求速率恒定在 ~8 req/s，任意时刻全国站点的新鲜度分布均匀，整体每站约 7 分钟更新一次。

预报数据的生命周期
------------------
nmc 的 /rest/weather 响应里同时带 real（实况）与 predict（逐日预报），所以刷新实况
时"顺带"更新预报，不产生额外请求。预报按 (code, date) 主键覆盖写，并记录本次抓取
时刻 fetched_at。**过去日期与异常日期（如接口偶发返回的 2020 年数据）一律不落库**，
prune() 每轮还会把库里遗留的过期行清掉 —— 保证 /api/station/<code> 拿到的永远是
"今天及以后"的预报窗口。

与爬虫的关系
------------
复用 crawler/ 里已验证的采集与解析逻辑（NmcClient / sanitize_station /
split_admin / parse_alarm），这里只负责"调度 + 增量落库 + 广播"。
"""
from __future__ import annotations

import json
import queue
import sqlite3
import sys
import threading
import time
import traceback
from collections import deque
from datetime import datetime, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
DB_PATH = BASE / "data" / "meteo.db"
sys.path.insert(0, str(BASE / "crawler"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_dataset import ADM2PROV, LEVEL_RANK, sanitize_station, split_admin   # noqa: E402
from nmc_client import NmcClient, RateLimited, TyphoonClient, parallel_map       # noqa: E402
from run_collect import parse_alarm                                             # noqa: E402
from weathercn_client import WeatherCnClient                                    # noqa: E402
import db as dbmod                                                               # noqa: E402
# 任务元信息（前端"实时引擎"页直接消费）
JOB_META = {
    "alarm": {
        "label": "预警信号", "interval": 60, "accent": "#ff8a00",
        "desc": "全国预警信号增量入库（nmc 全国流 + 中国天气网补充源，按 alertid 去重）",
    },
    "weather": {
        "label": "站点实况", "interval": 30, "accent": "#3fc6ff",
        "desc": "最久未更新优先轮转，每轮约 320 站；启动后连续预热 8 轮铺满全国，"
                "限速随对方限流自适应",
    },
    "typhoon": {
        "label": "台风路径", "interval": 1800, "accent": "#b48bff",
        "desc": "西北太平洋台风路径与强度序列",
    },
}

# ---- 预警写入守卫参数（2026-10-08 重做，原实现自锁 5 天，详见 job_alarm 注释）----
ALARM_MIN_COMPLETE_RATIO = 0.95   # 实际取到 / 上游自报总数 的完整性下限
ALARM_FORCE_ACCEPT_AFTER = 3      # 因"条数骤降"连续跳过满几轮后，强制接受新基线


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today_cutoff(hours: int = 30) -> str:
    return (datetime.now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M")


# 预报日期合法窗口：昨天 ~ 未来 15 天。
# nmc 的 predict 偶尔会返回 2020-07-01 这类明显异常的历史日期，
# 落库前一律拦掉，避免脏数据被前端当成"未来预报"渲染出来。
FORECAST_MIN_OFFSET = -1
FORECAST_MAX_OFFSET = 15


def forecast_window() -> tuple[str, str]:
    today = datetime.now().date()
    return ((today + timedelta(days=FORECAST_MIN_OFFSET)).isoformat(),
            (today + timedelta(days=FORECAST_MAX_OFFSET)).isoformat())


def valid_forecast_date(value, lo: str, hi: str) -> str | None:
    """校验预报日期：必须是 YYYY-MM-DD 且落在 [lo, hi] 窗口内。"""
    if not value:
        return None
    s = str(value)[:10]
    try:
        datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return None
    return s if lo <= s <= hi else None


# nmc 用哨兵值 9999 表示"这一项没有数据"。实况那半边由 crawler 的
# sanitize_station 兜住，**预报这半边以前没有兜**，于是"今天"那一格直接
# 渲染成「9999 / 9999°」——实测 2525 个站的当日预报全是这样，因为当天
# 白天的预报对接口来说已经没有意义了。
_FORECAST_SENTINEL_TEXT = ("9999", "-9999", "-", "--", "无", "null", "None")


def clean_num(v) -> float | None:
    """数值字段去哨兵，返回 float 或 None。"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f in (9999.0, -9999.0) else f


def clean_text(v) -> str | None:
    """文本字段去哨兵与占位，返回 str 或 None。"""
    if v is None:
        return None
    s = str(v).strip()
    return None if (not s or s in _FORECAST_SENTINEL_TEXT) else s


def parse_observ_payload(code: str, prov: str, city: str, raw: dict,
                         fetched_at: str) -> tuple[dict, list[tuple]]:
    """把 nmc /rest/weather 的原始响应解析成 (实况记录, 预报行列表)。

    实况与预报来自同一份响应，这一步纯解析、不落库，方便被"轮转任务"和
    "单站按需补采"两处复用。预报日期在此处就做合法性校验。
    """
    data = raw.get("data") or {}
    real = data.get("real") or {}
    w = real.get("weather") or {}
    rec = sanitize_station({
        "code": code, "province": prov, "city": city,
        "temp": w.get("temperature"), "feelst": w.get("feelst"),
        "humidity": w.get("humidity"), "pressure": w.get("airpressure"),
        "rain": w.get("rain"), "info": w.get("info"),
        "rcomfort": w.get("rcomfort"), "icomfort": w.get("icomfort"),
        "publish_time": real.get("publish_time"),
    })

    lo, hi = forecast_window()
    days: list[tuple] = []
    for dd in ((data.get("predict") or {}).get("detail") or []):
        day, night = dd.get("day") or {}, dd.get("night") or {}
        dw, nw = day.get("weather") or {}, night.get("weather") or {}
        date = valid_forecast_date(dd.get("date"), lo, hi)
        if date is None:                     # 异常/过期日期直接丢弃，不落库
            continue
        days.append((code, date, clean_text(dw.get("info")), clean_text(nw.get("info")),
                     clean_num(dw.get("temperature")), clean_num(nw.get("temperature")),
                     clean_text((day.get("wind") or {}).get("direct")),
                     clean_text((day.get("wind") or {}).get("power")),
                     clean_num(dd.get("precipitation")), fetched_at))
    return rec, days


# ==========================================================================
#  地理定位（完全依赖本地 region 表，实时更新时不产生额外网络请求）
# ==========================================================================
class GeoIndex:
    """用行政区划表把预警发布单位定位到经纬度。

    优先级：发布单位 adcode 直查 → 区县名 → 市名 → 省名。
    adcode 是最可靠的（'44011841600000' 前 6 位就是区县码），名字只作兜底。
    """

    def __init__(self, conn: sqlite3.Connection):
        self.by_ad: dict[str, tuple] = {}
        self.by_name: dict[tuple[str, str], tuple] = {}
        for r in conn.execute("SELECT adcode, name, level, parent, lng, lat FROM region"):
            ad, nm, lv, parent, lng, lat = r
            if lng is None or lat is None:
                continue
            self.by_ad[ad] = (lng, lat, lv)
            self.by_name.setdefault((lv, nm), (lng, lat, parent))

    def locate(self, adm_code: str, prov: str, city: str, county: str) -> tuple[float | None, float | None, str]:
        ac = "".join(ch for ch in (adm_code or "") if ch.isdigit())
        for cand, lv in ((ac[:6], "district"), (ac[:4] + "00", "city"), (ac[:2] + "0000", "province")):
            if len(cand) == 6 and cand in self.by_ad:
                lng, lat, real_lv = self.by_ad[cand]
                return lng, lat, real_lv
        for nm, lv in ((county, "district"), (city, "city"), (prov, "province")):
            if nm and (lv, nm) in self.by_name:
                lng, lat, _p = self.by_name[(lv, nm)]
                return lng, lat, lv
        return None, None, "none"


# ==========================================================================
#  实时引擎
# ==========================================================================
class LiveEngine:
    def __init__(self, db_path: Path | str = DB_PATH, enabled: bool = True,
                 alarm_interval: int = 60, weather_interval: int = 30,
                 weather_batch: int = 320, warmup_batch: int = 320,
                 typhoon_interval: int = 1800, alarm_max_pages: int = 15,
                 workers: int = 8, request_rate: float = 5.0,
                 min_rate: float = 1.5, bootstrap_rounds: int = 8,
                 geo: GeoIndex | None = None):
        self.db_path = Path(db_path)
        self.enabled = enabled
        self.workers = workers
        self.alarm_max_pages = alarm_max_pages
        self.weather_batch = weather_batch
        self.warmup_batch = warmup_batch
        self._warmed = False
        self.intervals = {
            "alarm": alarm_interval, "weather": weather_interval, "typhoon": typhoon_interval,
        }
        # ---- 自适应限速：目标站点会限流，稳态节奏只能"探"出来，不能拍脑袋定 ----
        self.base_rate = float(request_rate)      # 未被限流时的目标速率
        self.min_rate = float(min_rate)           # 被限流时允许降到的最低速率
        self.bootstrap_rounds = bootstrap_rounds  # 启动后连续跑几轮不等间隔，快速拉覆盖
        self._interval_scale = 1.0                # 轮转间隔放大系数（被限流时拉长）
        self._block_streak = 0                    # 连续被限流的轮数
        self._last_scale = 1.0
        self.last_weather: dict = {}              # 最近一轮实况采集的结果（用于判断数据源可用性）
        self.started_at = now_str()
        self.version = 0                     # 数据版本号：每次成功写入自增，前端据此判断"有新数据"
        self._geo = geo
        self._subs: list[queue.Queue] = []
        self._lock = threading.RLock()
        self._busy: dict[str, bool] = {k: False for k in JOB_META}
        self._threads: list[threading.Thread] = []
        self._stopping = threading.Event()
        self.logs: deque[str] = deque(maxlen=300)
        self.nmc = NmcClient(rate=request_rate)
        # 按需补采用**独立限速器**：轮转任务每轮打 320 个请求、几乎占满令牌桶，
        # 若共用同一个限速器，用户点开站点详情的补采请求会被排到几十秒之后。
        self.nmc_ondemand = NmcClient(rate=2.0, timeout=15)
        # 中国天气网预警补充源：nmc 的全国预警流**不收录青海省**（实测 15 天 0 条，
        # 同期中国天气网有果洛州雷电预警）。两源共用同一套国家预警发布中心 alertid，
        # 所以直接合并、按主键去重即可。单请求返回全国，限速放宽到 1/s 足够。
        self.weathercn = WeatherCnClient(rate=1.0, timeout=20)
        self.typhoon_cli = TyphoonClient(rate=4.0)
        self.state = {k: {"runs": 0, "errors": 0, "last_run": None, "last_ok": None,
                          "duration": None, "new": 0, "scanned": 0, "error": None,
                          "next_run": None} for k in JOB_META}

    # ---------------------------------------------------------------- 基础
    def connect(self) -> sqlite3.Connection:
        conn = dbmod.connect(self.db_path, timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    def log(self, msg: str) -> None:
        line = "[live %s] %s" % (datetime.now().strftime("%H:%M:%S"), msg)
        self.logs.append(line)
        print(line, flush=True)

    def geo_index(self, conn: sqlite3.Connection) -> GeoIndex:
        if self._geo is None:
            self._geo = GeoIndex(conn)
        return self._geo

    # ---------------------------------------------------------------- 广播
    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=64)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def broadcast(self, payload: dict) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass

    def emit_update(self, job: str, summary: dict) -> None:
        """数据写入完成后调用：版本号自增并推送变更摘要。"""
        with self._lock:
            self.version += 1
            ver = self.version
        self.broadcast({
            "type": "update", "version": ver, "job": job, "at": now_str(), **summary,
        })

    def record_event(self, kind: str, text: str, count: int = 0) -> None:
        """写入实时事件流（前端"数据流"面板 + 状态查询用），并即时广播。"""
        ts = now_str()
        try:
            conn = self.connect()
            conn.execute("INSERT INTO live_event (ts, kind, text, count) VALUES (?,?,?,?)",
                         (ts, kind, text, count))
            conn.commit()
            conn.close()
        except sqlite3.Error as exc:
            self.log("事件写入失败: %s" % exc)
        self.broadcast({"type": "event", "at": ts, "kind": kind, "text": text, "count": count})

    # ---------------------------------------------------------------- 任务：预警
    def _alarm_items(self) -> tuple[list[dict], list[str], dict]:
        """取一轮预警原始条目：nmc 全国流 + 中国天气网补充源，按 alertid 合并去重。

        nmc 优先（它的 pic 字段能反查图标），补充源只填 nmc 没有的（如青海）。
        某一源失败不影响另一源——记录到 warns 里返回，让日志看得见。

        第三个返回值是采集统计，供 job_alarm 做**完整性校验**（判断这一轮到底
        是"上游只有这么多"还是"分页半途挂了"）：
          · nmc_seen     —— nmc 侧实际拿到的条数
          · nmc_declared —— 上游第一页自报的总数（page.count），拿不到时为 None
        """
        merged: dict[str, dict] = {}
        warns: list[str] = []
        nmc_seen, nmc_declared = 0, None

        cli = self.nmc
        pages = min(cli.alarm_total_pages(200), self.alarm_max_pages)
        for p in range(1, pages + 1):
            j = cli.alarms(page_no=p, page_size=200)
            page = (j.get("data") or {}).get("page") or {}
            if p == 1:
                try:
                    nmc_declared = int(page.get("count")) if page.get("count") is not None else None
                except (TypeError, ValueError):
                    nmc_declared = None
            lst = page.get("list") or []
            if not lst:
                break
            for it in lst:
                rid = it.get("alertid")
                if rid and rid not in merged:
                    merged[rid] = it
                    nmc_seen += 1
            if len(lst) < 200:
                break

        try:
            for it in self.weathercn.alarms():
                rid = it.get("alertid")
                if rid and rid not in merged:
                    merged[rid] = it
        except Exception as e:              # noqa: BLE001
            warns.append("中国天气网补充源失败: %s" % str(e)[:80])

        return list(merged.values()), warns, {"nmc_seen": nmc_seen,
                                              "nmc_declared": nmc_declared}

    UPSERT_ALARM = (
        "INSERT INTO alarm (id, ts, date, hour, title, type, level, level_rank, issuer,"
        " province, city, county, adm_code, lng, lat, geo_level, icon, url, ingested_at,"
        " source, last_seen_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        # 罕见竞态（另一个进程刚好也插了同一条）时退化成"刷新生效标记"，别报错
        " ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at")

    def _log_scan(self, conn, ts: str, scanned: int, fresh: int, seen: int,
                  ok: int = 1, note: str = "") -> None:
        """记录一轮预警采集（用于自证"生效口径取自哪一轮"）。失败不影响主流程。"""
        try:
            conn.execute("INSERT OR REPLACE INTO alarm_scan"
                         " (ts, scanned, fresh, seen, ok, note) VALUES (?,?,?,?,?,?)",
                         (ts, scanned, fresh, seen, ok, note or None))
        except Exception as e:                          # noqa: BLE001
            self.logs.append("! alarm_scan 写入失败: %s" % str(e)[:80])

    def _skip_streak(self, conn) -> int:
        """最近连续多少轮因守卫跳过写入（从 alarm_scan 审计表数出来，重启不清零）。

        用审计表而不是内存计数器：进程重启后仍然知道"上游已经连着跳了多少轮"，
        否则每次重启都要重新熬过一轮熔断。
        """
        n = 0
        for r in conn.execute("SELECT note FROM alarm_scan ORDER BY ts DESC LIMIT 200"):
            if "跳过刷新" in (r["note"] or ""):
                n += 1
            else:
                break
        return n

    def job_alarm(self) -> dict:
        items, warns, up = self._alarm_items()
        ts_now = now_str()
        forced_note = ""            # 非空 = 本轮是"熔断后强制接受新基线"，写进审计表备查

        conn = self.connect()
        try:
            # 守卫一：上游一条都没返回。极可能是接口抽风 —— 绝不能拿空集合去刷
            # 生效标记，否则上一轮那 400 条会被整体判成"已失效"，地图瞬间清空。
            if not items:
                warns.append("本轮预警列表为空，保留上一轮生效快照")
                self._log_scan(conn, ts_now, 0, 0, 0, ok=0, note="空列表，跳过刷新")
                conn.commit()
                return {"new": 0, "scanned": 0, "warns": warns, "items": [],
                        "kept": True, "seen": 0}

            # 守卫二：【分页完整性校验】—— 拿"上游自报总数"比对"实际取到条数"。
            #
            # 这是唯一能区分"分页半途失败"与"上游真的只有这么多"的判据：
            #   nmc_seen <  declared  → 分页没拉全，多半半途挂了，保留旧快照；
            #   nmc_seen == declared  → 整份清单都拿到了，条数少就是上游真少，照常写入。
            #
            # 【为什么改】旧实现把阈值定成"上一轮成功快照条数的一半"，
            # 而基线取自 alarm 表里那份**它自己拒绝更新的**快照 —— 一旦上游从天气
            # 过程高峰自然回落（2026-10-03 的 815 条 → 10-08 的 130 条），
            # 每轮都被拦下 → last_seen_at 不更新 → 基线永远是 815 → 永久自锁。
            # 实测自锁 5 天（约 7200 轮），前端地图一直画 10-03 的旧点。
            declared, nmc_seen = up.get("nmc_declared"), up.get("nmc_seen") or 0
            if declared and nmc_seen < declared * ALARM_MIN_COMPLETE_RATIO:
                warns.append("本轮仅取到 %d/%d 条，疑上游分页半途失败，保留上一轮快照"
                             % (nmc_seen, declared))
                self._log_scan(conn, ts_now, len(items), 0, 0, ok=0,
                               note="分页不完整 %d/%d，跳过刷新" % (nmc_seen, declared))
                conn.commit()
                return {"new": 0, "scanned": len(items), "warns": warns, "items": [],
                        "kept": True, "seen": 0}

            # 守卫三：条数骤降只作**告警**，不再拦截。
            # 条数从 815 掉到 130 本来就可能只是天气转好，不该拿它来判断"采集坏了"。
            # 但也不能立刻无条件接受 —— 先用"连续跳过轮数"熔断：
            # 连续超过 ALARM_FORCE_ACCEPT_AFTER 轮仍异常，说明上游就是稳定在这个量级，
            # 强制接受并重建基线（否则一次真实回落又会把系统锁死）。
            prev_n = conn.execute(
                "SELECT COUNT(*) FROM alarm WHERE last_seen_at = "
                "(SELECT MAX(last_seen_at) FROM alarm)").fetchone()[0]
            if prev_n >= 20 and len(items) < prev_n * 0.5:
                streak = self._skip_streak(conn)
                if streak < ALARM_FORCE_ACCEPT_AFTER:
                    warns.append("本轮 %d 条（上一轮 %d 条），骤降归因未定，暂保留快照"
                                 "（连续第 %d 轮）" % (len(items), prev_n, streak + 1))
                    self._log_scan(conn, ts_now, len(items), 0, 0, ok=0,
                                   note="条数骤降 %d<%d，跳过刷新" % (len(items), prev_n))
                    conn.commit()
                    return {"new": 0, "scanned": len(items), "warns": warns, "items": [],
                            "kept": True, "seen": 0}
                warns.append("已连续 %d 轮骤降，判定上游真实回落，接受新基线（%d 条）"
                             % (streak, len(items)))
                # 不在这里写审计：下面正常落库流程会用同一个 ts 覆写一行更完整的记录
                forced_note = "骤降 %d 轮后接受新基线" % streak

            # 【生效口径】本轮返回的就是"此刻仍在生效"的清单，因此：
            #   · 本轮出现的 id  → 全部刷 last_seen_at（不管它是新是旧，长时效预警
            #                      如高温/干旱也会一轮轮被续上）
            #   · 库里本轮没出现的 → 生效标记停在旧时刻，自然退出生效集合，
            #                      但行**保留**给趋势图 / 时空回放用（绝不删）
            # 于是"最近一轮成功采集的那一批"= 权威的生效集合，无需拍 now-24h 硬窗口。
            known = {r["id"] for r in conn.execute("SELECT id FROM alarm")}
            geo, inserted, refreshed, fresh = None, 0, 0, []
            new_rows, seen_rows = [], []
            for it in items:
                rid = it.get("alertid")
                if not rid:
                    continue
                if rid in known:
                    seen_rows.append((ts_now, rid))
                    refreshed += 1
                    continue
                if geo is None:
                    geo = self.geo_index(conn)
                rec = parse_alarm(it)
                issuer = rec.get("issuer") or ""
                prov, city, county = split_admin(issuer)
                adm = rec.get("adm_code") or ""
                if not prov and len(adm) >= 2:
                    prov = ADM2PROV.get(adm[:2], "")
                lng, lat, lv = geo.locate(adm, prov, city, county)
                if lng is None and it.get("lng") is not None:
                    # 补充源自带区县质心；region 表查不到时用它兜底，别让点落空
                    lng, lat, lv = it.get("lng"), it.get("lat"), "district"
                ts = (it.get("issuetime") or "").replace("/", "-")
                url = it.get("url") or ""
                if url.startswith("/"):          # nmc 给的是相对路径
                    url = "http://www.nmc.cn" + url
                new_rows.append(
                    (rid, ts, ts[:10], int(ts[11:13]) if len(ts) >= 13 else None,
                     rec.get("title"), rec.get("type") or "其他", rec.get("level") or "未知",
                     LEVEL_RANK.get(rec.get("level"), 0), issuer, prov, city, county, adm,
                     lng, lat, lv, rec.get("icon"), url, ts_now,
                     it.get("source") or "nmc", ts_now))
                inserted += 1
                fresh.append({"id": rid, "ts": ts, "type": rec.get("type"),
                              "level": rec.get("level"), "place": county or city or prov,
                              "issuer": issuer, "lng": lng, "lat": lat,
                              "source": it.get("source") or "nmc"})
            if seen_rows:
                conn.executemany("UPDATE alarm SET last_seen_at = ? WHERE id = ?", seen_rows)
            if new_rows:
                conn.executemany(self.UPSERT_ALARM, new_rows)
            self._log_scan(conn, ts_now, len(items), inserted, refreshed, ok=1,
                           note=forced_note)
            conn.commit()
        finally:
            conn.close()

        if inserted:
            top = fresh[0]
            self.record_event("alarm", "新增 %d 条预警信号 · %s%s%s"
                              % (inserted, top.get("place") or "", top.get("type") or "",
                                 top.get("level") or ""), inserted)
        return {"new": inserted, "scanned": len(items), "warns": warns,
                "items": fresh[:20], "seen": refreshed}

    # ---------------------------------------------------------------- 任务：实况
    def job_weather(self) -> dict:
        ts_now = now_str()                 # 本批统一时间戳：实况与顺带刷新的预报共用
        conn = self.connect()
        try:
            # 首轮用更大的批次做"预热"，让全国覆盖率尽快爬升；之后回归常规轮转
            limit = self.warmup_batch if not self._warmed else self.weather_batch
            codes = [r["code"] for r in conn.execute(
                "SELECT s.code FROM station s LEFT JOIN observation o ON o.code = s.code "
                "WHERE o.next_try_at IS NULL OR o.next_try_at <= ? "
                "ORDER BY COALESCE(o.updated_at, '') ASC, s.code LIMIT ?", (ts_now, limit))]
            meta = {r["code"]: (r["province"], r["city"]) for r in conn.execute(
                "SELECT code, province, city FROM station")}
        finally:
            conn.close()
        if not codes:
            return {"new": 0, "scanned": 0}
        self._warmed = True

        def one(code: str):
            prov, city = meta.get(code, ("", ""))
            raw = self.nmc.weather(code)
            return parse_observ_payload(code, prov, city, raw, ts_now)

        ok, bad = parallel_map(one, codes, workers=self.workers, desc="实时实况")
        if bad:
            self.log("实况失败 %d 个：%s" % (len(bad), str(bad[:2])[:180]))
        conn = self.connect()
        try:
            prev = {r["code"]: r for r in conn.execute(
                "SELECT code, temp, humidity, rain, pressure, publish_time, updates"
                " FROM observation WHERE code IN (%s)" % ",".join("?" * len(ok)),
                [r["code"] for r, _ in ok])} if ok else {}
            obs_rows, fc_rows, changed = [], [], 0
            for rec, days in ok:
                code = rec["code"]
                p = prev.get(code)
                if p and p["temp"] is not None and rec.get("temp") is not None:
                    if abs(p["temp"] - rec["temp"]) >= 0.1:
                        changed += 1
                obs_rows.append((
                    code, ts_now, rec.get("publish_time"),
                    rec.get("temp"), rec.get("feelst"), rec.get("humidity"),
                    rec.get("rain"), rec.get("pressure"), rec.get("info"),
                    rec.get("rcomfort"), rec.get("icomfort"),
                    ts_now,
                    p["temp"] if p else None, p["humidity"] if p else None,
                    p["rain"] if p else None, p["pressure"] if p else None,
                    p["publish_time"] if p else None,
                    (p["updates"] or 0) + 1 if p else 1,
                    None, 0))                      # 成功：清空退避与失败计数
                fc_rows.extend(days)
            if obs_rows:
                conn.executemany(
                    "INSERT OR REPLACE INTO observation (code, collected_at, publish_time, temp,"
                    " feelst, humidity, rain, pressure, info, rcomfort, icomfort, updated_at,"
                    " prev_temp, prev_humidity, prev_rain, prev_pressure, prev_ts, updates,"
                    " next_try_at, fail_count)"
                    " VALUES (" + ",".join("?" * 20) + ")", obs_rows)
            if fc_rows:
                conn.executemany(
                    "INSERT OR REPLACE INTO forecast (code, date, day_info, night_info,"
                    " day_temp, night_temp, day_wind, day_power, precip, fetched_at)"
                    " VALUES (" + ",".join("?" * 10) + ")", fc_rows)
            # 拉不动的站点退避：整体被限流时退避更久（继续打只会让封禁窗口更长），
            # 单站异常则 20 分钟后自然重试，避免坏站点长期占据轮转队首
            if bad:
                heavy = len(bad) * 2 > len(codes)
                retry = (datetime.now() + timedelta(minutes=30 if heavy else 20)).strftime(
                    "%Y-%m-%d %H:%M:%S")
                conn.executemany(
                    "INSERT INTO observation (code, next_try_at, fail_count, updates) VALUES (?,?,1,0)"
                    " ON CONFLICT(code) DO UPDATE SET next_try_at = ?, fail_count = fail_count + 1",
                    [(c, retry, retry) for c, _e in bad])
            # 全国当前快照聚合（每分钟一行，构成"实时曲线"）
            snap = conn.execute("""
                SELECT COUNT(*) n, AVG(temp) ta, MAX(temp) tx, MIN(temp) tn, AVG(humidity) ha,
                       SUM(CASE WHEN rain > 0 THEN rain ELSE 0 END) rs,
                       SUM(CASE WHEN rain > 0 THEN 1 ELSE 0 END) rn
                FROM observation WHERE temp IS NOT NULL""").fetchone()
            conn.execute(
                "INSERT OR REPLACE INTO obs_stat (ts, n, temp_avg, temp_max, temp_min, hum_avg,"
                " rain_sum, rain_stations, temp_max_station, temp_min_station)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (ts_now, snap["n"], snap["ta"], snap["tx"], snap["tn"], snap["ha"],
                 snap["rs"] or 0, snap["rn"] or 0,
                 self._station_of(conn, snap["tx"], "desc"),
                 self._station_of(conn, snap["tn"], "asc")))
            conn.commit()
        finally:
            conn.close()

        if ok:
            avg = None
            try:
                c2 = self.connect()
                row = c2.execute("SELECT temp_avg FROM obs_stat ORDER BY ts DESC LIMIT 1").fetchone()
                avg = row[0] if row else None
                c2.close()
            except sqlite3.Error:
                pass
            self.record_event("weather", "刷新 %d 站实况 · 全国均温 %s ℃"
                              % (len(ok), ("%.1f" % avg) if avg is not None else "—"), len(ok))
        adj = self.adapt_rate(len(bad), len(codes))
        self.last_weather = {"at": ts_now, "ok": len(ok), "failed": len(bad),
                             "scanned": len(codes)}
        return {"new": len(ok), "scanned": len(codes), "changed": changed,
                "failed": len(bad), "throttle": adj}

    # ------------------------------------------------- 自适应限速
    def adapt_rate(self, failed: int, total: int) -> dict | None:
        """按本轮失败率自适应调整采集节奏（对抗目标站点限流）。

        中国气象局对高频访问会返回 403，而实测中 403 往往是**连接级**的：请求打得
        越密，封禁窗口越长，最后整批全灭 —— 也就是"越快越慢"。
        所以这里做成闭环控制：失败率高就降速并把轮转间隔成倍拉长，
        连续几轮干净后再缓慢提速。稳态速率由对方的容忍度决定，而不是写死常数。
        """
        if not total:
            return None
        ratio = failed / total
        cur = self.nmc.limiter.rate
        if ratio >= 0.4:                          # 明显被限流：降速 + 拉长间隔
            self._block_streak += 1
            new_rate = max(self.min_rate, cur * (0.6 if self._block_streak == 1 else 0.5))
            self._interval_scale = min(6.0, self._interval_scale * 1.5)
        elif ratio <= 0.05:                       # 本轮干净：慢慢提速
            if self._block_streak == 0 and self._interval_scale <= 1.0:
                return None
            self._block_streak = 0
            new_rate = min(self.base_rate, cur * 1.25)
            self._interval_scale = max(1.0, self._interval_scale / 1.5)
        else:
            return None
        if abs(new_rate - cur) < 0.05 and abs(self._last_scale - self._interval_scale) < 0.01:
            return None
        self._last_scale = self._interval_scale
        self.nmc.limiter.set_rate(new_rate)
        info = {"from": round(cur, 2), "rate": round(new_rate, 2),
                "interval_scale": round(self._interval_scale, 2),
                "fail_ratio": round(ratio, 3), "block_streak": self._block_streak}
        self.log("自适应限速：%s → %s req/s（失败率 %.0f%%）· 轮转间隔 ×%.1f"
                 % (info["from"], info["rate"], ratio * 100, self._interval_scale))
        self.record_event("system", "限速自适应：%s → %s req/s · 轮转间隔 ×%.1f"
                          % (info["from"], info["rate"], self._interval_scale), 0)
        return info

    # ------------------------------------------------- 按需补采（单站，打开详情时调用）
    def refresh_station(self, code: str, force: bool = False, max_age: int = 300) -> dict:
        """同步刷新单个站点，供前端打开站点详情时调用。

        轮转任务约 7 分钟才覆盖全国一遍，用户点开的那个站很可能刚好属于"最旧"的一批，
        等轮转就会觉得"数据不及时"。这里直接做一次单站采集（1 个请求，约 0.3 秒），
        实况与预报一并更新。max_age 内的数据视为已足够新，不会重复打接口。
        """
        conn = self.connect()
        try:
            st = conn.execute("SELECT province, city FROM station WHERE code = ?",
                              (code,)).fetchone()
            prev = conn.execute(
                "SELECT temp, humidity, rain, pressure, publish_time, updates, updated_at"
                " FROM observation WHERE code = ?", (code,)).fetchone()
        finally:
            conn.close()
        if not st:
            return {"ok": False, "refreshed": False, "msg": "站点不存在"}

        age = None
        if prev and prev["updated_at"]:
            try:
                age = (datetime.now() - datetime.strptime(
                    prev["updated_at"], "%Y-%m-%d %H:%M:%S")).total_seconds()
            except ValueError:
                age = None
        if not force and age is not None and age < max_age:
            return {"ok": True, "refreshed": False, "age": int(age),
                    "msg": "数据已足够新（%d 秒前刷新）" % int(age)}

        ts_now = now_str()
        try:
            raw = self.nmc_ondemand.weather(code)
        except Exception as exc:                       # noqa: BLE001
            return {"ok": False, "refreshed": False, "age": int(age) if age else None,
                    "msg": "采集失败：%s" % str(exc)[:140]}

        rec, days = parse_observ_payload(code, st["province"], st["city"], raw, ts_now)
        p = prev
        conn = self.connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO observation (code, collected_at, publish_time, temp,"
                " feelst, humidity, rain, pressure, info, rcomfort, icomfort, updated_at,"
                " prev_temp, prev_humidity, prev_rain, prev_pressure, prev_ts, updates,"
                " next_try_at, fail_count) VALUES (" + ",".join("?" * 20) + ")",
                (code, ts_now, rec.get("publish_time"),
                 rec.get("temp"), rec.get("feelst"), rec.get("humidity"),
                 rec.get("rain"), rec.get("pressure"), rec.get("info"),
                 rec.get("rcomfort"), rec.get("icomfort"), ts_now,
                 p["temp"] if p else None, p["humidity"] if p else None,
                 p["rain"] if p else None, p["pressure"] if p else None,
                 p["publish_time"] if p else None,
                 (p["updates"] or 0) + 1 if p else 1, None, 0))
            if days:
                conn.executemany(
                    "INSERT OR REPLACE INTO forecast (code, date, day_info, night_info,"
                    " day_temp, night_temp, day_wind, day_power, precip, fetched_at)"
                    " VALUES (" + ",".join("?" * 10) + ")", days)
            conn.commit()
        finally:
            conn.close()
        # 只登记事件流，不推 update —— 否则前端会因单站补采而整页重载
        self.record_event("weather", "按需补采 %s 实况" % (st["city"] or code), 1)
        return {"ok": True, "refreshed": True, "age": int(age) if age else None, "at": ts_now,
                "temp": rec.get("temp"), "feelst": rec.get("feelst"),
                "humidity": rec.get("humidity"), "rain": rec.get("rain"),
                "pressure": rec.get("pressure"), "info": rec.get("info"),
                "publish_time": rec.get("publish_time"), "forecast_days": len(days)}

    @staticmethod
    def _station_of(conn: sqlite3.Connection, value, order: str):
        if value is None:
            return None
        r = conn.execute(
            "SELECT s.city FROM observation o JOIN station s ON s.code = o.code "
            f"WHERE o.temp = ? ORDER BY o.temp {order} LIMIT 1", (value,)).fetchone()
        return r[0] if r else None

    # ---------------------------------------------------------------- 任务：台风
    def job_typhoon(self) -> dict:
        from db import typhoon_rows                     # 复用与建库一致的派生计算
        lst = self.typhoon_cli.list_default()
        pack = []
        for row in lst:
            try:
                d = self.typhoon_cli.view(row[0])
            except Exception:                           # noqa: BLE001
                continue
            arr = d.get("typhoon") or []
            pts = []
            seq = arr[8] if len(arr) > 8 and isinstance(arr[8], list) else []
            for p in seq:
                if not isinstance(p, list) or len(p) < 10:
                    continue
                pts.append({"time": p[1], "ts": p[2], "level": p[3], "lon": p[4], "lat": p[5],
                            "pressure": p[6], "wind_speed": p[7], "wind_dir": p[8],
                            "move_speed": p[9]})
            pack.append({"id": row[0], "name_en": row[1], "name_cn": row[2], "code": row[3],
                         "num": row[5], "active": row[6], "status": row[7], "path": pts})
        ty, pts = typhoon_rows(pack)
        conn = self.connect()
        try:
            if ty:
                conn.executemany("INSERT OR REPLACE INTO typhoon VALUES ("
                                 + ",".join("?" * 19) + ")", ty)
                conn.executemany("INSERT OR REPLACE INTO typhoon_path VALUES ("
                                 + ",".join("?" * 11) + ")", pts)
                conn.commit()
        finally:
            conn.close()
        active = sum(1 for t in pack if t.get("status") == "start")
        if ty:
            self.record_event("typhoon", "更新 %d 个台风路径 · 当前活跃 %d 个" % (len(ty), active),
                              len(ty))
        return {"new": len(ty), "scanned": len(pack), "active": active}

    # ---------------------------------------------------------------- 调度
    def run_job(self, name: str) -> dict:
        """同步执行一个任务，负责计时、状态维护、异常兜底与广播。"""
        if name not in JOB_META:
            raise KeyError(name)
        st = self.state[name]
        with self._lock:
            if self._busy[name]:
                return {"skipped": "任务正在运行"}
            self._busy[name] = True
        t0 = time.time()
        try:
            summary = {"alarm": self.job_alarm, "weather": self.job_weather,
                       "typhoon": self.job_typhoon}[name]()
            dur = round(time.time() - t0, 2)
            st.update({"runs": st["runs"] + 1, "last_run": now_str(), "last_ok": True,
                       "duration": dur, "error": None,
                       "new": summary.get("new", 0), "scanned": summary.get("scanned", 0)})
            if summary.get("new"):
                self.emit_update(name, {k: v for k, v in summary.items() if k != "items"}
                                 | {"items": summary.get("items", [])})
            else:
                self.broadcast({"type": "tick", "job": name, "version": self.version,
                                "at": now_str(), "new": 0})
            self.log("%s 完成：新增 %s / 扫描 %s，用时 %.2fs"
                     % (name, summary.get("new"), summary.get("scanned"), dur))
            for w in summary.get("warns") or []:
                self.log("  ! %s" % w)
            return summary
        except Exception as exc:                        # noqa: BLE001
            st.update({"runs": st["runs"] + 1, "errors": st["errors"] + 1,
                       "last_run": now_str(), "last_ok": False,
                       "duration": round(time.time() - t0, 2), "error": str(exc)[:200]})
            self.log("%s 失败：%s" % (name, exc))
            self.log(traceback.format_exc(limit=3))
            self.broadcast({"type": "error", "job": name, "at": now_str(), "msg": str(exc)[:160]})
            return {"new": 0, "error": str(exc)}
        finally:
            with self._lock:
                self._busy[name] = False
            # 轮转间隔随限流自适应拉长（_interval_scale），next_run 直接反映真实节奏
            gap = self.intervals[name] * (self._interval_scale if name == "weather" else 1.0)
            # 启动预热：前几轮不等间隔，尽快把覆盖率拉起来 —— 此时限速依然生效，
            # 并不会因为"连续跑"而额外增加目标站点的压力
            if name == "weather" and st["runs"] < self.bootstrap_rounds:
                gap = 1.0
            st["next_run"] = (datetime.now() + timedelta(seconds=gap)).strftime("%H:%M:%S")
            self.prune()

    def _loop(self, name: str) -> None:
        # 错峰启动，避免三个任务同时抢网络与写锁
        time.sleep({"alarm": 0.0, "weather": 3.0, "typhoon": 6.0}[name])
        while not self._stopping.is_set():
            st = self.state[name]
            if st["next_run"] is None:
                self.run_job(name)
            else:
                try:
                    target = datetime.strptime(st["next_run"], "%H:%M:%S").replace(
                        year=datetime.now().year, month=datetime.now().month,
                        day=datetime.now().day)
                    wait = max(1.0, (target - datetime.now()).total_seconds())
                except ValueError:
                    wait = self.intervals[name]
                if self._stopping.wait(min(wait, self.intervals[name] * 8)):
                    return
                self.run_job(name)

    def start(self) -> None:
        if not self.enabled:
            self.log("实时引擎未启用（--no-live 或 TIANSHU_LIVE=0）")
            return
        if self._threads:
            return
        for name in JOB_META:
            t = threading.Thread(target=self._loop, args=(name,),
                                 name="live-" + name, daemon=True)
            t.start()
            self._threads.append(t)
        hb = threading.Thread(target=self._heartbeat, name="live-heartbeat", daemon=True)
        hb.start()
        self._threads.append(hb)
        self.record_event("system", "实时引擎已启动 · 预警 60s / 实况轮转 / 台风 30min", 0)
        self.log("实时引擎已启动，任务：%s" % "、".join(JOB_META))

    def _heartbeat(self) -> None:
        """每 5 秒推一次轻量心跳，让前端知道"引擎活着"并刷新倒计时。"""
        while not self._stopping.is_set():
            self.broadcast({
                "type": "tick", "version": self.version, "at": now_str(),
                "jobs": {k: {"last_run": v["last_run"], "next_run": v["next_run"],
                             "new": v["new"], "ok": v["last_ok"], "busy": self._busy[k]}
                         for k, v in self.state.items()},
            })
            if self._stopping.wait(5):
                return

    def stop(self) -> None:
        self._stopping.set()

    def prune(self) -> None:
        """控制流表与预报表的体积。

        - live_event  留最近 800 条
        - alarm_scan  留最近 800 轮（预警采集审计，每轮一行，只为自证口径）
        - obs_stat    留最近 24 小时
        - forecast    只保留 [今天, 今天+15] 的日期行。预报按 (code,date) 覆盖写，
          过去的日期永远不会被再更新，不清就会一直堆在库里，前端"未来 7 日预报"
          里就会混进一周前的数据。

        注意下界用「今天」而不是 valid_forecast_date() 的「今天-1」：
        写入时放宽一天是为了容忍跨零点的载荷，但**入库后**昨天的行毫无用途——
        /api/station/<code> 本就按 date >= today 过滤，这些行永远不可见，
        只会以 fetched_at 为空的形式让数据库看起来不一致。
        """
        lo = datetime.now().date().isoformat()
        _, hi = forecast_window()
        try:
            conn = self.connect()
            conn.execute("DELETE FROM live_event WHERE id NOT IN "
                         "(SELECT id FROM live_event ORDER BY id DESC LIMIT 800)")
            conn.execute("DELETE FROM alarm_scan WHERE ts NOT IN "
                         "(SELECT ts FROM alarm_scan ORDER BY ts DESC LIMIT 800)")
            conn.execute("DELETE FROM obs_stat WHERE ts < ?",
                         ((datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S"),))
            conn.execute("DELETE FROM observation_history WHERE ts < ?",
                         ((datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S"),))
            cur = conn.execute("DELETE FROM forecast WHERE date < ? OR date > ?", (lo, hi))
            if cur.rowcount:
                self.log("清理过期预报 %d 行（窗口 %s ~ %s）" % (cur.rowcount, lo, hi))
            conn.commit()
            conn.close()
        except sqlite3.Error:
            pass

    # ---------------------------------------------------------------- 状态查询
    @staticmethod
    def _age_hours(ts) -> float | None:
        """时间串 -> 距今小时数。库里两种写法（分钟后有无秒）都要容忍。"""
        if not ts:
            return None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                return round((datetime.now()
                              - datetime.strptime(str(ts), fmt)).total_seconds() / 3600, 1)
            except ValueError:
                continue
        return None

    def status(self) -> dict:
        jobs = []
        for name, meta in JOB_META.items():
            st = self.state[name]
            left = None
            if st["next_run"]:
                try:
                    t = datetime.strptime(st["next_run"], "%H:%M:%S").replace(
                        year=datetime.now().year, month=datetime.now().month,
                        day=datetime.now().day)
                    left = max(0, int((t - datetime.now()).total_seconds()))
                except ValueError:
                    left = None
            jobs.append({**meta, "name": name, "interval": self.intervals[name],
                         # 实际生效的节奏（含自适应放大系数），前端据此显示"当前真实轮转周期"
                         "effective_interval": round(
                             self.intervals[name] *
                             (self._interval_scale if name == "weather" else 1.0), 1),
                         "busy": self._busy[name], "next_in": left, **{
                             k: st[k] for k in ("runs", "errors", "last_run", "last_ok",
                                                "duration", "new", "scanned", "error")}})
        fresh = {"alarm_total": 0, "coverage": 0.0, "station_total": 0}
        fresh_cut = (datetime.now() - timedelta(minutes=15)).strftime("%Y-%m-%d %H:%M:%S")
        try:
            conn = self.connect()
            r = conn.execute("""
                SELECT (SELECT COUNT(*) FROM alarm)                                  AS alarm_total,
                       (SELECT MAX(ts) FROM alarm)                                   AS alarm_latest,
                       (SELECT MAX(ingested_at) FROM alarm)                          AS alarm_ingested,
                       (SELECT COUNT(*) FROM alarm WHERE ingested_at >= ?)           AS alarm_new_1h,
                       (SELECT COUNT(*) FROM station)                                AS station_total,
                       (SELECT COUNT(*) FROM observation
                         WHERE updated_at >= ?)                                      AS obs_fresh,
                       (SELECT MAX(updated_at) FROM observation)                     AS obs_updated_at,
                       (SELECT MAX(updates) FROM observation)                        AS obs_max_updates,
                       (SELECT COUNT(*) FROM obs_stat)                               AS series_points,
                       (SELECT COUNT(*) FROM live_event)                             AS event_total,
                       (SELECT MAX(fetched_at) FROM forecast)                        AS forecast_fetched,
                       (SELECT COUNT(DISTINCT date) FROM forecast)                   AS forecast_days,
                       (SELECT COUNT(DISTINCT code) FROM forecast)                   AS forecast_codes,
                       (SELECT MIN(date) FROM forecast)                              AS forecast_from,
                       (SELECT MAX(date) FROM forecast)                              AS forecast_to
            """, (today_cutoff(1), fresh_cut)).fetchone()
            fresh = dict(r)
            fresh["coverage"] = round((r["obs_fresh"] or 0) / max(r["station_total"] or 1, 1), 4)
            # 【预警口径的时效】距最近一次成功采集多久。
            # 必须与"观测新鲜度"分开暴露：两者是独立支路，混为一谈会让
            # 99.9% 的实况覆盖率把"预警已几天没动"盖过去（2026-10-08 踩过，
            # 顶栏显示新鲜度 100% 时预警其实冻了 5 天）。
            # 阈值 36h 与 app.py 的 ACTIVE_STALE_HOURS 保持一致。
            age_h = self._age_hours(r["alarm_ingested"])
            fresh["alarm_age_h"] = age_h
            fresh["alarm_stale"] = bool(age_h is not None and age_h > 36)
            fresh["events"] = [dict(x) for x in conn.execute(
                "SELECT ts, kind, text, count FROM live_event ORDER BY id DESC LIMIT 24")]
            fresh["series"] = [dict(x) for x in conn.execute(
                "SELECT * FROM obs_stat ORDER BY ts DESC LIMIT 90")][::-1]
            # 分省数据新鲜度：该省站点里近 15 分钟已刷新的比例
            fresh["provinces"] = [dict(x) for x in conn.execute("""
                SELECT s.province AS name, COUNT(*) AS total,
                       SUM(CASE WHEN o.updated_at >= ? THEN 1 ELSE 0 END) AS fresh
                FROM station s LEFT JOIN observation o ON o.code = s.code
                GROUP BY s.province HAVING total > 0 ORDER BY total DESC""", (fresh_cut,))]
            fresh["updates_total"] = conn.execute(
                "SELECT COALESCE(SUM(updates), 0) FROM observation").fetchone()[0]
            conn.close()
        except sqlite3.Error as exc:
            fresh["error"] = str(exc)
        # 数据源可用性：最近一轮实况采集全军覆没 = 外部数据源不可达（断网 / 被限流封禁）
        # 前端据此显示"离线态 · 数据截至 xx"，而不是假装数据还在实时更新
        lw = self.last_weather or {}
        source_ok, source_note = True, ""
        if self.enabled and lw.get("scanned"):
            if lw.get("ok") == 0:
                source_ok = False
                source_note = ("上一轮 %d 个站点全部采集失败，数据源可能不可达"
                               % lw["scanned"])
            elif lw.get("failed", 0) * 2 > lw["scanned"]:
                source_note = ("上一轮失败 %d/%d，已启动自适应降速"
                               % (lw.get("failed", 0), lw["scanned"]))
        return {"enabled": self.enabled, "version": self.version, "server_time": now_str(),
                "started_at": self.started_at, "jobs": jobs, "freshness": fresh,
                "requests": {"ok": self.nmc.stat_ok, "fail": self.nmc.stat_fail},
                "source": {"ok": source_ok, "note": source_note,
                           "last_round": lw or None},
                # 启动预热状态：前 bootstrap_rounds 轮连续跑，覆盖率正在爬升
                "warming": bool(self.enabled
                                and self.state["weather"]["runs"] < self.bootstrap_rounds),
                "bootstrap_rounds": self.bootstrap_rounds,
                # 自适应限速的当前状态：前端"实时引擎"页据此显示引擎是自己降速还是被限流
                "throttle": {"rate": round(self.nmc.limiter.rate, 2),
                             "base_rate": self.base_rate, "min_rate": self.min_rate,
                             "interval_scale": round(self._interval_scale, 2),
                             "blocked_total": self.nmc.blocked,
                             "block_streak": self._block_streak,
                             "limited": self._block_streak > 0 or self._interval_scale > 1.0}}


# ==========================================================================
#  进程级单例（Flask 里通过 get_engine() 取用）
# ==========================================================================
_engine: LiveEngine | None = None


def get_engine() -> LiveEngine | None:
    return _engine


def start_engine(**kw) -> LiveEngine:
    global _engine
    if _engine is None:
        _engine = LiveEngine(**kw)
        _engine.start()
    return _engine


if __name__ == "__main__":                              # 独立运行（不开 Web 也能持续积累数据）
    import argparse
    ap = argparse.ArgumentParser(description="天枢实时数据引擎（独立进程模式）")
    ap.add_argument("--once", help="只跑一次指定任务：alarm/weather/typhoon")
    ap.add_argument("--weather-batch", type=int, default=300)
    a = ap.parse_args()
    if a.once:
        eng = LiveEngine(enabled=True, weather_batch=a.weather_batch)
        print(json.dumps(eng.run_job(a.once), ensure_ascii=False, indent=1)[:1200])
    else:
        eng = start_engine(weather_batch=a.weather_batch)
        print("实时引擎运行中，Ctrl+C 退出")
        try:
            while True:
                time.sleep(30)
                s = eng.status()["freshness"]
                print("[%s] 预警 %s 条 | 15 分钟内刷新站点 %s 个（覆盖率 %.1f%%）"
                      % (now_str(), s.get("alarm_total"), s.get("obs_fresh"),
                         (s.get("coverage") or 0) * 100), flush=True)
        except KeyboardInterrupt:
            eng.stop()
