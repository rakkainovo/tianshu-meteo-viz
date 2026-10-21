(function (global) {
  'use strict';
  const levels = ['', '蓝色', '黄色', '橙色', '红色'];
  const nameKey = s => String(s || '').replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|自治州|地区|省|市|县|区)$/, '');
  const time = s => Date.parse(String(s || '').replace(' ', 'T') + '+08:00');
  function inRegion(row, trail) {
    return trail.every(region => {
      const code = String(row.adm_code || '');
      const prefix = String(region.adcode).slice(0, region.level === 'province' ? 2 : region.level === 'city' ? 4 : 6);
      return (code.length === 6 && code.startsWith(prefix)) || nameKey(row[region.level]) === nameKey(region.name);
    });
  }
  function filter(rows, opts) {
    return rows.filter(r => (!opts.type || r.type === opts.type)
      && (!opts.rank || Number(r.level_rank) >= opts.rank)
      && inRegion(r, opts.trail || [])
      && (!opts.historical || (r._time >= opts.start && r._time <= opts.cursor)));
  }
  function aggregate(rows, geo, field) {
    const named = new Map();
    rows.forEach(r => {
      const key = nameKey(r[field]);
      const stat = named.get(key) || { count: 0, rank: 0 };
      stat.count++;
      stat.rank = Math.max(stat.rank, Number(r.level_rank) || 0);
      named.set(key, stat);
    });
    return (geo.features || []).filter(f => f.properties.name).map(f => {
      const stat = named.get(nameKey(f.properties.name)) || { count: 0, rank: 0 };
      return { feature: f, name: f.properties.name, adcode: String(f.properties.adcode),
        count: stat.count, rank: stat.rank, level: levels[stat.rank] || '未知' };
    });
  }
  global.SandData = { time, nameKey, inRegion, filter, aggregate, levels };
})(window);
