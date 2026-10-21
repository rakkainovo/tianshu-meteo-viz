# -*- coding: utf-8 -*-
"""
snapshot.py —— 演示数据快照（答辩 / 断网演示前固化数据用）

为什么需要它
------------
天枢的实时引擎会持续往 data/meteo.db 里写新数据。这在平时是优点，但演示时
有两个麻烦：一是数据处于"正在进行时"，截图和讲解口径容易对不上；二是万一
演示现场断网，采集任务会一直失败刷日志，干扰讲解。

快照把当前数据库**冻结**成一个带时间戳的副本，之后随时可以一键回到那个状态。

用法
----
    python crawler/snapshot.py                     # 生成快照 data/snapshots/meteo-YYYYmmdd-HHMM.db
    python crawler/snapshot.py --list              # 列出已有快照
    python crawler/snapshot.py --restore <文件>    # 用某个快照覆盖当前数据库（会先备份现库）

配合 start.bat 的 --no-live 使用效果最好：断网也能完整演示。
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
DB_PATH = BASE / "data" / "meteo.db"
SNAP_DIR = BASE / "data" / "snapshots"


def summarize(path: Path) -> str:
    conn = sqlite3.connect(path)
    try:
        def q(sql, default=0):
            try:
                return conn.execute(sql).fetchone()[0] or default
            except sqlite3.Error:
                return default
        return ("预警 %s 条 · 站点 %s 个 · 有效观测 %s 个 · 预报 %s 行 · "
                "实况截至 %s" % (q("SELECT COUNT(*) FROM alarm"),
                                 q("SELECT COUNT(*) FROM station"),
                                 q("SELECT COUNT(*) FROM observation WHERE temp IS NOT NULL"),
                                 q("SELECT COUNT(*) FROM forecast"),
                                 q("SELECT MAX(updated_at) FROM observation", "—")))
    finally:
        conn.close()


def create(note: str = "") -> Path:
    if not DB_PATH.exists():
        print("找不到数据库：%s" % DB_PATH)
        sys.exit(1)
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    out = SNAP_DIR / ("meteo-%s.db" % stamp)
    # 用 sqlite 的 backup API 而不是 shutil.copy —— 引擎可能正在写，直接拷可能拿到半截事务
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(out)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    meta = SNAP_DIR / ("meteo-%s.txt" % stamp)
    meta.write_text("生成时间: %s\n备注: %s\n内容: %s\n"
                    % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), note, summarize(out)),
                    encoding="utf-8")
    print("快照已生成：%s" % out)
    print("  %s" % summarize(out))
    return out


def list_snapshots() -> None:
    if not SNAP_DIR.exists():
        print("还没有任何快照。")
        return
    files = sorted(SNAP_DIR.glob("meteo-*.db"))
    if not files:
        print("还没有任何快照。")
        return
    for f in files:
        print("%-34s %7.1f MB  %s" % (f.name, f.stat().st_size / 1048576, summarize(f)))


def restore(path: Path) -> None:
    if not path.exists():
        print("快照不存在：%s" % path)
        sys.exit(1)
    if DB_PATH.exists():
        bak = DB_PATH.with_name("meteo.before-restore-%s.db"
                                % datetime.now().strftime("%Y%m%d-%H%M%S"))
        shutil.copy(DB_PATH, bak)
        print("当前数据库已备份到：%s" % bak)
    shutil.copy(path, DB_PATH)
    print("已从快照恢复：%s" % path)
    print("  %s" % summarize(DB_PATH))


def main() -> int:
    ap = argparse.ArgumentParser(description="天枢演示数据快照")
    ap.add_argument("--list", action="store_true", help="列出已有快照")
    ap.add_argument("--restore", metavar="文件", help="用指定快照覆盖当前数据库")
    ap.add_argument("--note", default="", help="快照备注（写进同名 txt）")
    a = ap.parse_args()
    if a.list:
        list_snapshots()
    elif a.restore:
        p = Path(a.restore)
        restore(p if p.is_absolute() else (SNAP_DIR / p))
    else:
        create(a.note)
    return 0


if __name__ == "__main__":
    sys.exit(main())
