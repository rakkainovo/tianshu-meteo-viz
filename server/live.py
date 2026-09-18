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
    站点实况     60 s / 300 站   "最久未刷新优先"轮转，约 9 分钟覆盖全国 2528 站
    台风路径     30 min          路径与强度全量覆盖写（路径只会变长）

为什么实况要轮转而不是每次全量
------------------------------
一次全量扫 2528 个站点约 7 分钟、2528 次请求，如果每分钟都全量扫，等于 24 h 不
间断高频请求对方服务器 —— 既不礼貌也没必要。改成"每分钟刷新最久未更新的 300 站"，
请求速率恒定在 ~5 req/s，任意时刻全国站点的新鲜度分布均匀，整体每站约 9 分钟更新一次。

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
from nmc_client import NmcClient, TyphoonClient, parallel_map                   # noqa: E402
from run_collect import parse_alarm                                             # noqa: E402

# 任务元信息（前端"实时引擎"页直接消费）
JOB_META = {
    "alarm": {
        "label": "预警信号", "interval": 60, "accent": "#ff8a00",
        "desc": "全国预警信号增量入库（按 alertid 去重）",
    },
    "weather": {
        "label": "站点实况", "interval": 45, "accent": "#3fc6ff",
        "desc": "最久未更新优先轮转，每轮 300 站，约 13 分钟覆盖全国 2528 站",
    },
    "typhoon": {
        "label": "台风路径", "interval": 1800, "accent": "#b48bff",
        "desc": "西北太平洋台风路径与强度序列",
    },
}


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today_cutoff(hours: int = 30) -> str:
    return (datetime.now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M")


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
                 alarm_interval: int = 60, weather_interval: int = 45,
                 weather_batch: int = 300, warmup_batch: int = 900,
                 typhoon_interval: int = 1800, alarm_max_pages: int = 15,
                 workers: int = 8, geo: GeoIndex | None = None):
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
        self.started_at = now_str()
        self.version = 0                     # 数据版本号：每次成功写入自增，前端据此判断"有新数据"
        self._geo = geo
        self._subs: list[queue.Queue] = []
        self._lock = threading.RLock()
        self._busy: dict[str, bool] = {k: False for k in JOB_META}
        self._threads: list[threading.Thread] = []
        self._stopping = threading.Event()
        self.logs: deque[str] = deque(maxlen=300)
        self.nmc = NmcClient(rate=6.0)
        self.typhoon_cli = TyphoonClient(rate=4.0)
        self.state = {k: {"runs": 0, "errors": 0, "last_run": None, "last_ok": None,
                          "duration": None, "new": 0, "scanned": 0, "error": None,
                          "next_run": None} for k in JOB_META}

    # ---------------------------------------------------------------- 基础
    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
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
    def job_alarm(self) -> dict:
        cli = self.nmc
        pages = min(cli.alarm_total_pages(200), self.alarm_max_pages)
        items: list[dict] = []
        for p in range(1, pages + 1):
            j = cli.alarms(page_no=p, page_size=200)
            lst = ((j.get("data") or {}).get("page") or {}).get("list") or []
            if not lst:
                break
            items.extend(lst)
            if len(lst) < 200:
                break

        conn = self.connect()
        try:
            geo = self.geo_index(conn)
            have = {r["id"] for r in conn.execute(
                "SELECT id FROM alarm WHERE ts >= ?", (today_cutoff(48),))}
            inserted, fresh = 0, []
            ts_now = now_str()
            for it in items:
                rid = it.get("alertid")
                if not rid or rid in have:
                    continue
                rec = parse_alarm(it)
                issuer = rec.get("issuer") or ""
                prov, city, county = split_admin(issuer)
                adm = rec.get("adm_code") or ""
                if not prov and len(adm) >= 2:
                    prov = ADM2PROV.get(adm[:2], "")
                lng, lat, lv = geo.locate(adm, prov, city, county)
                ts = (it.get("issuetime") or "").replace("/", "-")
                conn.execute(
                    "INSERT OR REPLACE INTO alarm (id, ts, date, hour, title, type, level,"
                    " level_rank, issuer, province, city, county, adm_code, lng, lat,"
                    " geo_level, icon, url, ingested_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (rid, ts, ts[:10], int(ts[11:13]) if len(ts) >= 13 else None,
                     rec.get("title"), rec.get("type") or "其他", rec.get("level") or "未知",
                     LEVEL_RANK.get(rec.get("level"), 0), issuer, prov, city, county, adm,
                     lng, lat, lv, rec.get("icon"),
                     "http://www.nmc.cn" + (it.get("url") or ""), ts_now))
                inserted += 1
                fresh.append({"id": rid, "ts": ts, "type": rec.get("type"),
                              "level": rec.get("level"), "place": county or city or prov,
                              "issuer": issuer, "lng": lng, "lat": lat})
            conn.commit()
        finally:
            conn.close()

        if inserted:
            top = fresh[0]
            self.record_event("alarm", "新增 %d 条预警信号 · %s%s%s"
                              % (inserted, top.get("place") or "", top.get("type") or "",
                                 top.get("level") or ""), inserted)
        return {"new": inserted, "scanned": len(items), "items": fresh[:20]}

    # ---------------------------------------------------------------- 任务：实况
    def job_weather(self) -> dict:
        conn = self.connect()
        try:
            # 首轮用更大的批次做"预热"，让全国覆盖率尽快爬升；之后回归常规轮转
            limit = self.warmup_batch if not self._warmed else self.weather_batch
            now = now_str()
            codes = [r["code"] for r in conn.execute(
                "SELECT s.code FROM station s LEFT JOIN observation o ON o.code = s.code "
                "WHERE o.next_try_at IS NULL OR o.next_try_at <= ? "
                "ORDER BY COALESCE(o.updated_at, '') ASC, s.code LIMIT ?", (now, limit))]
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
            # 顺手刷新 7 日预报（同一份响应里已经带回来了，不额外产生请求）
            days = []
            for dd in ((data.get("predict") or {}).get("detail") or []):
                day, night = dd.get("day") or {}, dd.get("night") or {}
                dw, nw = day.get("weather") or {}, night.get("weather") or {}

                def num(v):
                    try:
                        return float(v)
                    except (TypeError, ValueError):
                        return None
                days.append((code, dd.get("date"), dw.get("info"), nw.get("info"),
                             num(dw.get("temperature")), num(nw.get("temperature")),
                             (day.get("wind") or {}).get("direct"),
                             (day.get("wind") or {}).get("power"),
                             num(dd.get("precipitation"))))
            return rec, days

        ok, bad = parallel_map(one, codes, workers=self.workers, desc="实时实况")
        if bad:
            self.log("实况失败 %d 个：%s" % (len(bad), str(bad[:2])[:180]))
        ts_now = now_str()
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
                conn.executemany("INSERT OR REPLACE INTO forecast VALUES (?,?,?,?,?,?,?,?,?)", fc_rows)
            # 拉不动的站点退避 20 分钟，避免坏站点长期占据轮转队首
            if bad:
                retry = (datetime.now() + timedelta(minutes=20)).strftime("%Y-%m-%d %H:%M:%S")
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
        return {"new": len(ok), "scanned": len(codes), "changed": changed, "failed": len(bad)}

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
            st["next_run"] = (datetime.now()
                              + timedelta(seconds=self.intervals[name])).strftime("%H:%M:%S")
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
                if self._stopping.wait(min(wait, self.intervals[name])):
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
        """控制两张流表的体积：事件流留最近 800 条，聚合曲线留最近 24 小时。"""
        try:
            conn = self.connect()
            conn.execute("DELETE FROM live_event WHERE id NOT IN "
                         "(SELECT id FROM live_event ORDER BY id DESC LIMIT 800)")
            conn.execute("DELETE FROM obs_stat WHERE ts < ?",
                         ((datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S"),))
            conn.commit()
            conn.close()
        except sqlite3.Error:
            pass

    # ---------------------------------------------------------------- 状态查询
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
                       (SELECT COUNT(*) FROM live_event)                             AS event_total
            """, (today_cutoff(1), fresh_cut)).fetchone()
            fresh = dict(r)
            fresh["coverage"] = round((r["obs_fresh"] or 0) / max(r["station_total"] or 1, 1), 4)
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
        return {"enabled": self.enabled, "version": self.version, "server_time": now_str(),
                "started_at": self.started_at, "jobs": jobs, "freshness": fresh,
                "requests": {"ok": self.nmc.stat_ok, "fail": self.nmc.stat_fail}}


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
