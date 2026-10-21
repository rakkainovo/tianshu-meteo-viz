# -*- coding: utf-8 -*-
"""一次性维护脚本：修正「预警（无"信号"后缀）」标题的解析结果。

背景：ALARM_RE 原先硬编码结尾「预警信号」，导致 12 条标题以「预警」结尾的
记录整条解析失败 —— type 兜底成「其他」、level 兜底成「未知」（rank=0），
在环形图/等级筛选/详情层里表现为一个莫名的「未知」等级。

本脚本：
  1) 用修好的正则重新解析库内所有 title，与现状比对，打印差异（干跑）；
  2) --apply 时才真正 UPDATE（默认干跑，安全）。
只改 level / level_rank / type 三个字段，不动 ts、geo 等。

用法：
  python fix_alarm_level.py            # 干跑，只打印
  python fix_alarm_level.py --apply    # 真正写库
"""
import re
import sqlite3
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE / "crawler"))

from build_dataset import LEVEL_RANK            # noqa: E402
from run_collect import ALARM_RE                # noqa: E402

DB = BASE / "data" / "meteo.db"


def main():
    apply = "--apply" in sys.argv
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = list(conn.execute("SELECT id, title, type, level, level_rank FROM alarm"))

    changes, unmatched, same = [], 0, 0
    for r in rows:
        t = r["title"] or ""
        hits = ALARM_RE.findall(t)
        if not hits:
            unmatched += 1
            continue
        issuer, typ, lv = hits[0]
        rank = LEVEL_RANK.get(lv, 0)
        if (r["type"], r["level"], r["level_rank"]) == (typ, lv, rank):
            same += 1
            continue
        changes.append((r["id"], r["type"], r["level"], r["level_rank"], typ, lv, rank, t))

    print("总记录 %d | 解析成功且无需改 %d | 解析失败 %d | 需修正 %d"
          % (len(rows), same, unmatched, len(changes)))
    for c in changes:
        print("  %s\n    type %s -> %s | level %s(%s) -> %s(%s)\n    %s"
              % (c[0], c[1], c[4], c[2], c[3], c[5], c[6], c[7][:70]))

    if not apply:
        print("\n[干跑] 未写库。加 --apply 生效。")
        return
    for c in changes:
        conn.execute("UPDATE alarm SET type=?, level=?, level_rank=? WHERE id=?",
                     (c[4], c[5], c[6], c[0]))
    conn.commit()
    print("\n已写库：修正 %d 条。" % len(changes))
    print("剩余未知等级：", conn.execute(
        "SELECT COUNT(*) FROM alarm WHERE level='未知'").fetchone()[0])
    print("等级分布：", [tuple(x) for x in conn.execute(
        "SELECT level, COUNT(*) FROM alarm GROUP BY level ORDER BY 2 DESC")])
    conn.close()


if __name__ == "__main__":
    main()
