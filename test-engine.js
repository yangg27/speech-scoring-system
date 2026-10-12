// 计分引擎验证：从 app.js 抽取纯函数并在 Node 中执行
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function slice(startMarker, endMarker){
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker);
  if (a < 0 || b < 0 || b <= a) throw new Error('marker not found: ' + startMarker);
  return src.slice(a, b);
}

const utils = slice('function esc(s){', '/* ---------------- 3. 数据层');
const engine = slice('const DEFAULT_DIMS', '/* ---------------- 5. 全局状态');

const code = `
${utils}
${engine}
module.exports = { computeResults, normDims, normSettings, DEFAULT_DIMS, DEFAULT_SETTINGS, fx, num };
`;
const sandbox = { module: { exports: {} }, console };
const fn = new Function('module', 'console', code);
fn(sandbox.module, console);
const { computeResults, normDims, normSettings } = sandbox.module.exports;

/* -------- 构造测试场景 -------- */
const event = {
  id: 1,
  name: '测试演讲比赛',
  dimensions: normDims([
    { id: 'd1', name: '主题内容', max: 30, weight: 1 },
    { id: 'd2', name: '语言表达', max: 30, weight: 1 },
    { id: 'd3', name: '台风仪表', max: 20, weight: 1 },
    { id: 'd4', name: '时间控制', max: 20, weight: 1 }
  ]),
  settings: normSettings({ dropHighest: false, dropLowest: false, dropCount: 1 })
};

const speakers = [
  { id: 1, seq: 1, name: '张三', department: '市场部' },
  { id: 2, seq: 2, name: '李四', department: '技术部' },
  { id: 3, seq: 3, name: '王五', department: '人事部' }
];

// 3 位评委对所有选手打分
const scores = [
  // 张三：三位评委
  { speaker_id: 1, judge_name: '评委A', scores: { d1: 27, d2: 26, d3: 18, d4: 17 }, updated_at: '2026-10-09T10:00:00Z' },
  { speaker_id: 1, judge_name: '评委B', scores: { d1: 28, d2: 25, d3: 19, d4: 18 }, updated_at: '2026-10-09T10:01:00Z' },
  { speaker_id: 1, judge_name: '评委C', scores: { d1: 26, d2: 27, d3: 17, d4: 16 }, updated_at: '2026-10-09T10:02:00Z' },
  // 李四
  { speaker_id: 2, judge_name: '评委A', scores: { d1: 22, d2: 24, d3: 16, d4: 15 }, updated_at: '2026-10-09T10:03:00Z' },
  { speaker_id: 2, judge_name: '评委B', scores: { d1: 21, d2: 23, d3: 15, d4: 14 }, updated_at: '2026-10-09T10:04:00Z' },
  { speaker_id: 2, judge_name: '评委C', scores: { d1: 23, d2: 22, d3: 17, d4: 16 }, updated_at: '2026-10-09T10:05:00Z' },
  // 王五
  { speaker_id: 3, judge_name: '评委A', scores: { d1: 24, d2: 25, d3: 18, d4: 18 }, updated_at: '2026-10-09T10:06:00Z' },
  { speaker_id: 3, judge_name: '评委B', scores: { d1: 25, d2: 26, d3: 19, d4: 19 }, updated_at: '2026-10-09T10:07:00Z' }
];

const res = computeResults(event, speakers, scores);

let pass = 0, fail = 0;
function check(label, actual, expected){
  const a = typeof actual === 'number' ? Math.round(actual * 100) / 100 : actual;
  const ok = Math.abs(Number(a) - Number(expected)) < 0.011 || String(a) === String(expected);
  console.log((ok ? '✅' : '❌') + ' ' + label + '  实际=' + a + ' 预期=' + expected);
  ok ? pass++ : fail++;
}

console.log('=== 1. 基础计算（不去分） ===');
// 张三 d1 = (27+28+26)/3 = 27
check('张三 主题内容均分', res.rows.find(r => r.speaker.id === 1).dims.d1.avg, 27);
// 张三 d2 = (26+25+27)/3 = 26
check('张三 语言表达均分', res.rows.find(r => r.speaker.id === 1).dims.d2.avg, 26);
// 张三总分 = 27 + 26 + 18 + 17 = 88
check('张三 总分', res.rows.find(r => r.speaker.id === 1).total, 88);
// 李四 d1 = (22+21+23)/3 = 22; d2=23; d3=16; d4=15 → 76
check('李四 总分', res.rows.find(r => r.speaker.id === 2).total, 76);
// 王五 d1=(24+25)/2=24.5; d2=25.5; d3=18.5; d4=18.5 → 87
check('王五 总分', res.rows.find(r => r.speaker.id === 3).total, 87);

console.log('\n=== 2. 排名 ===');
check('第1名是张三', res.ranked[0].speaker.name, '张三');
check('第2名是王五', res.ranked[1].speaker.name, '王五');
check('第3名是李四', res.ranked[2].speaker.name, '李四');
check('张三 rank=1', res.ranked[0].rank, 1);

console.log('\n=== 3. 评委统计 ===');
check('评委数=3', res.judges.length, 3);
const ja = res.judgeStats.find(j => j.name === '评委A');
check('评委A 已评3人', ja.scored, 3);
check('评委A 完成率=100%', Math.round(ja.rate * 100), 100);
const jb = res.judgeStats.find(j => j.name === '评委B');
check('评委B 已评3人', jb.scored, 3);

console.log('\n=== 4. 维度统计 ===');
// d1 全场均分 = (27+22+24.5)/3 = 24.5
const d1 = res.dimStats.find(d => d.id === 'd1');
check('主题内容 全场均分', d1.avg, 24.5);
check('主题内容 得分率', Math.round(d1.rate * 10000) / 100, Math.round(24.5 / 30 * 10000) / 100);

console.log('\n=== 5. 去掉最高分最低分 ===');
const ev2 = Object.assign({}, event, { settings: normSettings({ dropHighest: true, dropLowest: true, dropCount: 1 }) });
const res2 = computeResults(ev2, speakers, scores);
// 张三 d1 原始 [27,28,26] → 去28和26 → 剩27
check('张三 去分后 d1', res2.rows.find(r => r.speaker.id === 1).dims.d1.avg, 27);
check('张三 去分后剔除2个', res2.rows.find(r => r.speaker.id === 1).dims.d1.removed.length, 2);
// 王五 d1 只有 2 个值 [24,25]，不满足 2*1+1=3 → 不去分
check('王五 票数不足不去分', res2.rows.find(r => r.speaker.id === 3).dims.d1.avg, 24.5);
check('王五 剔除数=0', res2.rows.find(r => r.speaker.id === 3).dims.d1.removed.length, 0);

console.log('\n=== 6. 同分并列 ===');
const scoresTie = scores.map(s => s.speaker_id === 2 ? Object.assign({}, s, { scores: { d1: 27, d2: 26, d3: 18, d4: 17 } }) : s);
const res3 = computeResults(event, speakers, scoresTie);
const r1 = res3.ranked.find(r => r.speaker.name === '张三');
const r2 = res3.ranked.find(r => r.speaker.name === '李四');
check('张三/李四 同分', r1.total, r2.total);
check('同分并列排名一致', r1.rank === r2.rank ? 'yes' : 'no', 'yes');

console.log('\n=== 7. 权重 ===');
const ev4 = Object.assign({}, event, { dimensions: normDims([
  { id: 'd1', name: '主题内容', max: 30, weight: 2 },
  { id: 'd2', name: '语言表达', max: 30, weight: 1 }
])});
const res4 = computeResults(ev4, speakers, scores);
// 张三：d1=27*2=54, d2=26*1=26 → 80；上限 30*2+30*1=90
check('加权总分', res4.rows.find(r => r.speaker.id === 1).total, 80);
check('加权上限', res4.rows.find(r => r.speaker.id === 1).maxTotal, 90);

console.log('\n=== 8. 维度强弱项分析（王五相对最强/最弱） ===');
const r3 = res3.rows.find(r => r.speaker.id === 3);
const rel = res.dims.map(d => ({ name: d.name, rel: r3.dims[d.id].rate - res.dimStats.find(x => x.id === d.id).rate }));
rel.sort((a, b) => b.rel - a.rel);
console.log('   王五相对最强：' + rel[0].name + ' (+' + (rel[0].rel * 100).toFixed(1) + '%)');
console.log('   王五相对最弱：' + rel[rel.length - 1].name + ' (' + (rel[rel.length - 1].rel * 100).toFixed(1) + '%)');
check('相对强弱项可计算', typeof rel[0].rel === 'number' ? 'yes' : 'no', 'yes');

console.log('\n=== 9. 边界情况 ===');
const empty = computeResults(event, [], []);
check('空数据不报错', empty.ranked.length, 0);
const noScore = computeResults(event, speakers, []);
check('零评分不报错', noScore.ranked.length, 3);
check('零评分总分为0', noScore.rows[0].total, 0);
const partial = computeResults(event, speakers, [{ speaker_id: 1, judge_name: 'X', scores: { d1: 20 } }]);
check('部分维度缺失不报错', typeof partial.rows[0].total === 'number' ? 'yes' : 'no', 'yes');
check('部分维度时 complete=false', partial.rows[0].complete, false);

console.log('\n=== 10. 移除评委：其评分不计入统计 ===');
/* 基线：3 位评委 */
const baseRes = computeResults(event, speakers, scores);
const baseZhang = baseRes.rows.find(r => r.speaker.id === 1).total;
check('基线：3 位评委参与', baseRes.judges.length, 3);

/* 移除评委B → 张家总分应变化，且 judges 不含 B */
const evEx = { id: 1, name: 'x', dimensions: event.dimensions,
  settings: normSettings({ excludedJudges: ['评委B'] }) };
const exRes = computeResults(evEx, speakers, scores);
check('移除后：有效评委剩 2 位', exRes.judges.length, 2);
check('移除后：名单不含被移除者', exRes.judges.indexOf('评委B'), -1);
check('移除后：总分与基线不同', exRes.rows.find(r => r.speaker.id === 1).total !== baseZhang, true);
/* 手工核算：张三 评委A d1=27, 评委C d1=26 → 均值 26.5（而非含 B 的 27） */
const zhangD1 = exRes.rows.find(r => r.speaker.id === 1).dims['d1'].avg;
check('移除后：维度均值按剩余评委重算', Math.abs(zhangD1 - 26.5) < 1e-9, true);
check('保留原始数据条数不变', exRes.allScores.length, scores.length);
check('有效评分条数已减少', exRes.activeScores.length < scores.length, true);
check('已移除评委可被列出', exRes.excludedStats.length, 1);
check('已移除评委名正确', exRes.excludedStats[0].name, '评委B');
check('已移除评委带历史评分条数', exRes.excludedStats[0].scored > 0, true);

/* 全部移除 → 全部为 0 分 */
const allEx = computeResults({ id: 1, dimensions: event.dimensions,
  settings: normSettings({ excludedJudges: ['评委A', '评委B', '评委C'] }) }, speakers, scores);
check('全部移除后无有效评委', allEx.judges.length, 0);
check('全部移除后总分为 0', allEx.rows[0].total, 0);
check('全部移除后已移除列表 3 位', allEx.excludedStats.length, 3);

/* 不存在的名字不出现在排除列表 */
const noneEx = computeResults({ id: 1, dimensions: event.dimensions,
  settings: normSettings({ excludedJudges: [] }) }, speakers, scores);
check('空排除列表 = 全量参与', noneEx.judges.length, 3);
check('空排除时无已移除项', noneEx.excludedStats.length, 0);

console.log('\n=== 11. 异常留痕：同设备/同IP 多评委检测 ===');
const metaScores = [
  { speaker_id: 1, judge_name: '甲', scores: { d1: 20 }, meta: { device_id: 'DEV1', ip: '1.1.1.1' } },
  { speaker_id: 2, judge_name: '乙', scores: { d1: 21 }, meta: { device_id: 'DEV1', ip: '1.1.1.1' } },
  { speaker_id: 3, judge_name: '丙', scores: { d1: 22 }, meta: { device_id: 'DEV2', ip: '1.1.1.1' } },
  { speaker_id: 1, judge_name: '丁', scores: { d1: 23 }, meta: { device_id: 'DEV3', ip: '2.2.2.2',
    from_judge: '甲', switch_approved: true } }
];
const metaRes = computeResults(event, speakers, metaScores);
check('检出同设备多评委 1 台', metaRes.deviceAlerts.length, 1);
check('该设备涉及 2 位评委', metaRes.deviceAlerts[0].judges.length, 2);
check('检出同IP多评委 1 个', metaRes.ipAlerts.length, 1);
check('该IP涉及 3 位评委', metaRes.ipAlerts[0].judges.length, 3);
check('检出切换记录 1 条', metaRes.switchLogs.length, 1);
check('切换记录 来源正确', metaRes.switchLogs[0].from, '甲');
check('切换记录 已放行标记', metaRes.switchLogs[0].approved, true);
/* 无 meta 的老数据不应误报 */
const legacyRes = computeResults(event, speakers, [
  { speaker_id: 1, judge_name: 'X', scores: { d1: 20 } },
  { speaker_id: 2, judge_name: 'Y', scores: { d1: 20 } }
]);
check('无留痕的老数据不误报设备异常', legacyRes.deviceAlerts.length, 0);
check('无留痕的老数据不误报IP异常', legacyRes.ipAlerts.length, 0);
/* 共用 WiFi：同 IP 但不同设备 → 不应报设备异常（这是正常的） */
const wifiRes = computeResults(event, speakers, [
  { speaker_id: 1, judge_name: 'A', scores: { d1: 20 }, meta: { device_id: 'D1', ip: '9.9.9.9' } },
  { speaker_id: 2, judge_name: 'B', scores: { d1: 20 }, meta: { device_id: 'D2', ip: '9.9.9.9' } }
]);
check('共用WiFi：设备异常为 0', wifiRes.deviceAlerts.length, 0);
check('共用WiFi：IP 提示 1 条（正常现象）', wifiRes.ipAlerts.length, 1);

console.log('\n=== 12. 去最高/最低分的口径（明确固化） ===');
/* 口径：对「每位选手 × 每个维度」的评分集合，各自独立剔除最高/最低。
   即：剔的是"某个维度上的极端分"，不是"某位评委的整场总分"。 */
const ddims = normDims([
  { id: 'd1', name: '维度1', max: 25, weight: 1 },
  { id: 'd2', name: '维度2', max: 25, weight: 1 }
]);
const dspk = [{ id: 1, seq: 1, name: '张三' }];
const dsc = [
  { speaker_id: 1, judge_name: 'A', scores: { d1: 25, d2: 15 } },
  { speaker_id: 1, judge_name: 'B', scores: { d1: 20, d2: 20 } },
  { speaker_id: 1, judge_name: 'C', scores: { d1: 20, d2: 20 } },
  { speaker_id: 1, judge_name: 'D', scores: { d1: 15, d2: 25 } }
];
const dres = computeResults({ id: 1, dimensions: ddims,
  settings: normSettings({ dropHighest: true, dropLowest: true, dropCount: 1 }) }, dspk, dsc);
const o1 = dres.rows[0].dims['d1'], o2 = dres.rows[0].dims['d2'];
check('口径：逐维度各自剔除极值（d1 剔 25 与 15）', o1.removed.slice().sort((a, b) => a - b).join(','), '15,25');
check('口径：d2 同样各自剔除（剔 25 与 15）', o2.removed.slice().sort((a, b) => a - b).join(','), '15,25');
check('口径：d1 均值 = 中间两位', o1.avg, 20);
check('口径：d2 均值 = 中间两位', o2.avg, 20);
check('口径：剔除后总分', dres.rows[0].total, 40);
/* 关键差异：同一位评委在不同维度可能被剔或不被剔（非整场剔除） */
const keepMultidim = computeResults({ id: 1, dimensions: ddims,
  settings: normSettings({ dropHighest: true, dropLowest: false, dropCount: 1 }) }, dspk, dsc);
check('口径：只剔最高时 d1 剔 A(25)', keepMultidim.rows[0].dims['d1'].removed.join(','), '25');
check('口径：只剔最高时 d2 剔 D(25)', keepMultidim.rows[0].dims['d2'].removed.join(','), '25');
/* 有效票数不足时不剔除（防样本过少失真） */
const fewRes = computeResults({ id: 1, dimensions: ddims,
  settings: normSettings({ dropHighest: true, dropLowest: true, dropCount: 1 }) }, dspk, [
  { speaker_id: 1, judge_name: 'A', scores: { d1: 25, d2: 25 } },
  { speaker_id: 1, judge_name: 'B', scores: { d1: 20, d2: 20 } }
]);
check('口径：仅2位评委时不剔除（需≥3）', fewRes.rows[0].dims['d1'].removed.length, 0);
check('口径：不剔除时取全部均值', fewRes.rows[0].dims['d1'].avg, 22.5);
/* 3 位评委刚好触发剔除 */
const triRes = computeResults({ id: 1, dimensions: ddims,
  settings: normSettings({ dropHighest: true, dropLowest: true, dropCount: 1 }) }, dspk, [
  { speaker_id: 1, judge_name: 'A', scores: { d1: 25, d2: 25 } },
  { speaker_id: 1, judge_name: 'B', scores: { d1: 20, d2: 20 } },
  { speaker_id: 1, judge_name: 'C', scores: { d1: 10, d2: 10 } }
]);
check('口径：3位评委触发剔除', triRes.rows[0].dims['d1'].removed.length, 2);
check('口径：3位评委时剩中间值', triRes.rows[0].dims['d1'].avg, 20);

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);