# -*- coding: utf-8 -*-
"""Semantic regression tests with known station facts, without network access."""
import datetime as dt
import json
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import db
import qa
import qa_data

CLOCK = dt.datetime(2026, 10, 9, 12, 0)


class WeatherQuestions(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(db.SCHEMA)
        self.conn.executemany("INSERT INTO station(code,city,province) VALUES (?,?,?)", [
            ("rRKjq", "沙坪坝", "重庆市"), ("bei01", "北碚", "重庆市"),
            ("bj001", "朝阳", "北京市"), ("ln001", "朝阳", "辽宁省"),
            ("sh001", "徐家汇", "上海市"), ("wen01", "温县", "河南省"),
            ("tq001", "天全", "四川省"), ("miss1", "缺测站", "重庆市"),
        ])
        self.conn.executemany("INSERT INTO observation(code,temp,humidity,rain,pressure,info,publish_time,updated_at,collected_at) VALUES (?,?,?,?,?,?,?,?,?)", [
            (code, temp, hum, rain, 1000, "多云", "2026-10-09 11:50:00", "2026-10-09 11:55:00", "2026-10-09 11:55:00")
            for code, temp, hum, rain in [("rRKjq", 25, 60, 0), ("bei01", 23, 80, 2),
                ("bj001", 20, 50, 0), ("ln001", 15, 40, 0), ("sh001", 28, 75, 0), ("wen01", 99, 90, 0), ("tq001", 10, 85, 0), ("miss1", None, 100, None)]
        ])
        self.conn.executemany("INSERT INTO forecast(code,date,day_info,night_info,day_temp,night_temp,day_wind,day_power,fetched_at) VALUES (?,?,?,?,?,?,?,?,?)", [
            ("rRKjq", "2026-10-10", "小雨", "多云", 26, 18, "西风", "微风", "2026-10-09 11:00:00"),
            ("bei01", "2026-10-10", "晴", "晴", 24, 16, "东风", "微风", "2026-10-09 11:00:00"),
        ])
        self.conn.execute('DELETE FROM observation_history')
        self.conn.executemany("INSERT INTO observation_history(code,ts,temp,humidity) VALUES (?,?,?,?)", [
            ("rRKjq", "2026-10-08 13:00:00", 21, 70), ("rRKjq", "2026-10-09 11:00:00", 25, 60),
            ("bei01", "2026-10-08 13:00:00", 20, 75), ("bei01", "2026-10-09 11:00:00", 23, 80),
        ])
        self.clock = patch.object(qa_data, "now", return_value=CLOCK)
        self.network = patch.object(qa, "llm_available", return_value=False)
        self.clock.start()
        self.network.start()

    def tearDown(self):
        self.clock.stop()
        self.network.stop()
        self.conn.close()

    def ask(self, q, context=None, **kwargs):
        return qa.answer_question(q, self.conn, context, **kwargs)

    def test_exact_code_is_not_a_place_alias(self):
        r = self.ask("rRKjq站现在气温多少？")
        self.assertIn("25℃", r["answer"])
        self.assertNotIn("温县", r["answer"])
        self.assertEqual(r["focus"]["params"]["code"], "rRKjq")
        self.assertEqual(r["queries"][0]["params"], ["rRKjq"])

    def test_unknown_code_does_not_guess(self):
        r = self.ask("54511站现在气温多少？")
        self.assertEqual(r["intent"], "clarify")
        self.assertIn("未找到", r["answer"])

    def test_short_city_name_does_not_match_temperature_word(self):
        r = self.ask("现在气温多少？")
        self.assertEqual(r["intent"], "clarify")
        self.assertNotIn("温县", r["answer"])

    def test_tomorrow_is_forecast(self):
        r = self.ask("沙坪坝站明天天气怎么样？")
        self.assertEqual(r["intent"], "station_forecast")
        self.assertIn("26℃", r["answer"])
        self.assertIn("小雨", r["answer"])
        self.assertIn("2026-10-10", r["answer"])
        self.assertNotIn("25℃", r["answer"])

    def test_followup_keeps_station_and_changes_time(self):
        first = self.ask("沙坪坝站现在气温多少？")
        second = self.ask("它明天呢？", first["context"])
        self.assertEqual(second["context"]["scopes"][0]["code"], "rRKjq")
        self.assertEqual(second["context"]["start"], "2026-10-10")
        third = self.ask("现在湿度呢？", second["context"])
        self.assertEqual(third["context"]["mode"], "observation")
        self.assertIn("60%", third["answer"])

    def test_new_question_resets_previous_date(self):
        first = self.ask("沙坪坝站明天天气怎么样？")
        r = self.ask("北京和上海哪个更热？", first["context"])
        self.assertEqual(r["context"]["mode"], "observation")
        self.assertIn("低 8℃", r["answer"])
        self.assertNotIn("预警总数", r["answer"])

    def test_compare_followup_adds_second_station(self):
        first = self.ask("沙坪坝站现在气温多少？")
        r = self.ask("和北碚比呢？", first["context"])
        self.assertEqual(len(r["context"]["scopes"]), 2)
        self.assertIn("高 2℃", r["answer"])

    def test_ambiguous_station_requires_selection(self):
        r = self.ask("朝阳站现在湿度多少？")
        self.assertEqual({s["code"] for s in r["candidates"]}, {"bj001", "ln001"})
        selected = self.ask("选择朝阳", r["context"], selection="ln001")
        self.assertIn("40%", selected["answer"])
        self.assertEqual(selected["context"]["scopes"][0]["code"], "ln001")

    def test_province_disambiguates_station(self):
        r = self.ask("北京朝阳站现在气温多少？")
        self.assertEqual(r["context"]["scopes"][0]["code"], "bj001")

    def test_ambiguous_station_alarm_also_requires_selection(self):
        r = self.ask('朝阳站有哪些生效预警？')
        self.assertEqual(r['intent'], 'clarify')
        self.assertEqual(len(r['candidates']), 2)

    def test_history_answers_temperature_not_alarms(self):
        r = self.ask("沙坪坝站最近24小时气温变化如何？")
        self.assertEqual(r["intent"], "station_history")
        self.assertIn("+4.0℃", r["answer"])
        self.assertEqual(r["chart"]["series"][0]["data"], [21, 25])
        self.assertNotIn("预警数量", r["answer"])

    def test_history_shortage_is_explicit(self):
        r = self.ask("朝阳站最近24小时气温变化如何？", selection="bj001", context={"pending_question": "北京朝阳站最近24小时气温变化如何？"})
        self.assertIn("不足以分析", r["answer"])
        self.assertIsNone(r["chart"])

    def test_missing_forecast_never_uses_observation(self):
        r = self.ask("徐家汇站明天天气怎么样？")
        self.assertIn("没有可用预报", r["answer"])
        self.assertNotIn("28℃", r["answer"])

    def test_yesterday_uses_history(self):
        r = self.ask("沙坪坝站昨天气温如何？")
        self.assertEqual(r["context"]["mode"], "history")
        self.assertIn("只有 1 条", r["answer"])

    def test_today_observed_maximum_is_not_a_forecast(self):
        r = self.ask('沙坪坝站今天最高气温多少？')
        self.assertEqual(r['context']['mode'], 'history')
        self.assertNotIn('26℃', r['answer'])

    def test_page_selection_is_used_for_deictic_question(self):
        r = self.ask("这个站现在气温多少？", page_context={"station_code": "rRKjq"})
        self.assertIn("25℃", r["answer"])

    def test_missing_temp_does_not_hide_humidity(self):
        r = self.ask("重庆现在湿度多少？")
        self.assertIn("80%", r["answer"])

    def test_unknown_place_does_not_reuse_context(self):
        first = self.ask("沙坪坝站现在气温多少？")
        r = self.ask("伦敦现在气温多少？", first["context"])
        self.assertEqual(r["intent"], "clarify")
        r = self.ask("伦敦现在气温多少？", page_context={'station_code': 'rRKjq'})
        self.assertEqual(r['intent'], 'clarify')

    def test_compound_query_keeps_weather_and_alarms(self):
        r = self.ask('沙坪坝站现在天气如何，明天天气和预警情况如何？')
        self.assertEqual(r['intent'], 'weather_tools')
        self.assertIn('25℃', r['answer'])
        self.assertIn('26℃', r['answer'])
        self.assertIn('所在地生效预警', r['answer'])

    def test_forecast_comparison_is_computed(self):
        r = self.ask("沙坪坝站和北碚站明天哪个更热？")
        self.assertIn("高 2℃", r["answer"])

    def test_umbrella_uses_forecast(self):
        r = self.ask("沙坪坝站明天要带伞吗？")
        self.assertIn("建议带伞", r["answer"])

    def test_stale_station_time_is_reported(self):
        self.conn.execute("UPDATE observation SET publish_time='2026-10-08 12:00:00' WHERE code='rRKjq'")
        r = self.ask("沙坪坝站现在气温多少？")
        self.assertIn("超过2小时", r["answer"])

    def test_history_deduplicates_polls(self):
        db.record_observation_history(self.conn, ["rRKjq"])
        db.record_observation_history(self.conn, ["rRKjq"])
        count = self.conn.execute("SELECT COUNT(*) FROM observation_history WHERE code='rRKjq' AND ts='2026-10-09 11:50:00'").fetchone()[0]
        self.assertEqual(count, 1)

    def test_current_writer_automatically_records_history(self):
        self.conn.execute("UPDATE observation SET temp=27,publish_time='2026-10-09 12:00:00' WHERE code='rRKjq'")
        row = self.conn.execute("SELECT temp FROM observation_history WHERE code='rRKjq' AND ts='2026-10-09 12:00:00'").fetchone()
        self.assertEqual(row[0], 27)
        self.conn.execute("UPDATE observation SET temp=28 WHERE code='rRKjq'")
        count = self.conn.execute("SELECT COUNT(*) FROM observation_history WHERE code='rRKjq' AND ts='2026-10-09 12:00:00'").fetchone()[0]
        self.assertEqual(count, 1)
        self.assertEqual(self.conn.execute("SELECT temp FROM observation_history WHERE code='rRKjq' AND ts='2026-10-09 12:00:00'").fetchone()[0], 28)

    def test_api_accepts_context_and_rejects_invalid_payload(self):
        import app as server
        client = server.app.test_client()
        self.assertEqual(client.post('/api/qa', json={'q': ['wrong']}).status_code, 400)
        self.assertEqual(client.post('/api/qa', json=['wrong']).status_code, 400)
        self.assertEqual(client.post('/api/qa', json={'q': '天气', 'selection': {}}).status_code, 400)
        def connection():
            cloned = sqlite3.connect(':memory:')
            cloned.row_factory = sqlite3.Row
            self.conn.commit()
            self.conn.backup(cloned)
            return cloned
        with patch.object(server, 'db', side_effect=connection):
            first = client.post('/api/qa', json={'q': '沙坪坝站现在气温多少？'}).get_json()
            second = client.post('/api/qa', json={'q': '它明天呢？', 'context': first['context']}).get_json()
        self.assertEqual(first['focus']['params']['code'], 'rRKjq')
        self.assertIn('26℃', second['answer'])

    def test_tool_cannot_silently_change_requested_station(self):
        responses = [
            {'tool_calls': [{'id': 'c1', 'function': {'name': 'get_weather', 'arguments': json.dumps({'scopes': [{'kind': 'station', 'code': 'wen01'}]})}}]},
            {'content': '数据不足。'},
        ]
        with patch.object(qa, 'llm_available', return_value=True), patch.object(qa, '_llm_chat', side_effect=responses):
            r = qa_data.answer_with_tools('沙坪坝站气温如何', self.conn)
        self.assertIsNone(r)

    def test_legacy_questions_remain_supported_without_network(self):
        import test_qa
        actual = sqlite3.connect('file:' + str(Path(__file__).resolve().parents[1] / 'data' / 'meteo.db') + '?mode=ro', uri=True)
        actual.row_factory = sqlite3.Row
        try:
            for question, expected in test_qa.CASES:
                with self.subTest(question=question):
                    r = qa.answer_question(question, actual)
                    self.assertEqual(r['intent'], expected)
                    self.assertTrue(r['answer'])
        finally:
            actual.close()

    def test_invalid_metric_and_tool_are_rejected(self):
        tool = qa_data.WeatherQuery(self.conn)
        with self.assertRaises(ValueError):
            tool.dispatch("get_weather", {"scopes": [{"kind": "station", "code": "rRKjq"}], "metric": "temp; DELETE FROM station"})
        with self.assertRaises(ValueError):
            tool.dispatch("execute_sql", {"sql": "DELETE FROM station"})
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM station").fetchone()[0], 8)

    def test_tool_results_with_different_metrics_are_not_compared(self):
        tool = qa_data.WeatherQuery(self.conn)
        outputs = [tool.observation([{'kind': 'station', 'code': 'rRKjq'}], 'temp'),
                   tool.observation([{'kind': 'station', 'code': 'bei01'}], 'humidity')]
        r = qa_data.render(tool, outputs, '查询气温和湿度')
        self.assertNotIn('对比结论', r['answer'])
        self.assertIsNone(r['chart'])

    def test_llm_reads_actual_station_via_tools(self):
        responses = [
            {"content": None, "tool_calls": [{"id": "c1", "function": {"name": "search_stations", "arguments": json.dumps({"query": "沙坪坝"})}}]},
            {"content": None, "tool_calls": [{"id": "c2", "function": {"name": "get_weather", "arguments": json.dumps({"scopes": [{"kind": "station", "code": "rRKjq"}], "metric": "temp"})}}]},
            {"content": "当前气温25℃。"},
        ]
        with patch.object(qa, "llm_available", return_value=True), patch.object(qa, "_llm_chat", side_effect=responses) as llm:
            r = qa_data.answer_with_tools("帮我分析沙坪坝的情况", self.conn)
        self.assertIn("25℃", r["answer"])
        self.assertEqual(r["engine"], "tools+llm")
        self.assertEqual(llm.call_count, 3)

    def test_invented_llm_number_is_not_shown(self):
        responses = [
            {"tool_calls": [{"id": "c1", "function": {"name": "get_weather", "arguments": json.dumps({"scopes": [{"kind": "station", "code": "rRKjq"}]})}}]},
            {"content": "该站气温999℃。"},
        ]
        with patch.object(qa, "llm_available", return_value=True), patch.object(qa, "_llm_chat", side_effect=responses):
            r = qa_data.answer_with_tools("查询沙坪坝", self.conn)
        self.assertNotIn("999℃", r["answer"])
        self.assertIn("25℃", r["answer"])

    def test_repeated_tools_do_not_duplicate_answers_or_lose_forecast_context(self):
        scope = [{'kind': 'station', 'code': 'rRKjq'}]
        calls = []
        for i, (name, arguments) in enumerate([
            ('get_weather', {'scopes': scope, 'metric': 'temp'}),
            ('get_weather', {'scopes': scope, 'metric': 'weather'}),
            ('get_forecast', {'scopes': scope, 'start': '2026-10-10', 'metric': 'temp'}),
            ('get_forecast', {'scopes': scope, 'start': '2026-10-10', 'metric': 'weather'}),
            ('get_forecast', {'scopes': scope, 'start': '2026-10-10', 'metric': 'rain'}),
            ('get_alarms', {'scopes': scope}),
        ]):
            calls.append({'id': str(i), 'function': {'name': name, 'arguments': json.dumps(arguments)}})
        responses = [{'tool_calls': calls}, {'content': '明天需留意降雨。'}]
        with patch.object(qa, 'llm_available', return_value=True), patch.object(qa, '_llm_chat', side_effect=responses):
            r = qa_data.answer_with_tools('请结合沙坪坝站实时气温和明天天气，综合分析出行情况', self.conn)
        self.assertEqual(r['intent'], 'weather_tools')
        self.assertEqual(r['context']['mode'], 'forecast')
        self.assertEqual(r['context']['start'], '2026-10-10')
        self.assertEqual(len(r['queries']), 3)
        self.assertEqual(r['answer'].count('逐日预报'), 1)
        self.assertEqual(r['answer'].count('| 气温 |'), 1)
        self.assertIn('户外活动', r['answer'])


if __name__ == "__main__":
    unittest.main(verbosity=2)
