// 端到端数据链路验证：模拟前端匿名读写云数据库（与 app.js 使用同一套 REST 路径与鉴权头）
// ⚠️ 运行前请把下面的配置换成你自己的云服务（与 app.js 保持一致）
const PUBLIC_CONFIG = {
  endpoint: 'https://YOUR-APP.app.workbuddy.host',
  publishableKey: 'wbpk_REPLACE_WITH_YOUR_KEY'
};

const BASE = PUBLIC_CONFIG.endpoint + '/.cloud/database/rest';

function headers(extra){
  return Object.assign({
    'apikey': PUBLIC_CONFIG.publishableKey,
    'Authorization': 'Bearer ' + PUBLIC_CONFIG.publishableKey,
    'Origin': PUBLIC_CONFIG.endpoint,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }, extra || {});
}

let pass = 0, fail = 0;
function check(label, ok, extra){
  console.log((ok ? '✅' : '❌') + ' ' + label + (extra ? '  [' + extra + ']' : ''));
  ok ? pass++ : fail++;
}

async function req(method, path, body, extra){
  const r = await fetch(BASE + path, {
    method,
    headers: headers(extra),
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  const txt = await r.text();
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  return { status: r.status, data };
}

(async () => {
  console.log('=== 匿名读写链路验证（模拟评委端/管理端） ===\n');

  // 1. 建活动
  const ev = await req('POST', '/events', {
    name: '[自检] 端到端验证活动',
    dimensions: [
      { id: 'd1', name: '主题内容', max: 30, weight: 1 },
      { id: 'd2', name: '语言表达', max: 30, weight: 1 }
    ],
    settings: { dropHighest: false, dropLowest: false, dropCount: 1 },
    status: 'live'
  }, { 'Prefer': 'return=representation' });
  check('创建活动 (匿名 INSERT events)', ev.status === 201 && Array.isArray(ev.data) && ev.data.length === 1,
    'HTTP ' + ev.status + (ev.data && ev.data[0] ? ' id=' + ev.data[0].id : ''));
  if (!Array.isArray(ev.data) || !ev.data[0]) { console.log('   响应:', JSON.stringify(ev.data).slice(0, 300)); process.exit(1); }
  const eventId = ev.data[0].id;

  // 2. 读取活动
  const evRead = await req('GET', '/events?id=eq.' + eventId);
  check('读取活动 (匿名 SELECT events)', evRead.status === 200 && evRead.data.length === 1, 'HTTP ' + evRead.status);
  const dimsBack = evRead.data[0].dimensions;
  check('jsonb 字段往返正确', Array.isArray(dimsBack) && dimsBack.length === 2 && dimsBack[0].name === '主题内容',
    JSON.stringify(dimsBack).slice(0, 80));

  // 3. 批量添加选手
  const spk = await req('POST', '/speakers', [
    { event_id: eventId, seq: 1, name: '张三', department: '市场部' },
    { event_id: eventId, seq: 2, name: '李四', department: '技术部' },
    { event_id: eventId, seq: 3, name: '王五', department: '人事部' }
  ], { 'Prefer': 'return=representation' });
  check('批量添加选手 (匿名 INSERT speakers)', spk.status === 201 && spk.data.length === 3, 'HTTP ' + spk.status);
  const sid = {};
  spk.data.forEach(s => { sid[s.name] = s.id; });

  // 4. 按 seq 排序读取
  const spkRead = await req('GET', '/speakers?event_id=eq.' + eventId + '&order=seq.asc');
  const names = spkRead.data.map(s => s.name).join(',');
  check('按序号排序读取选手', names === '张三,李四,王五', names);

  // 5. 评委提交评分（模拟三位评委）
  const mk = (spkName, judge, s1, s2) => ({
    event_id: eventId, speaker_id: sid[spkName], judge_name: judge,
    scores: { d1: s1, d2: s2 }, comment: ''
  });
  const sc = await req('POST', '/scores', [
    mk('张三', '评委A', 28, 27), mk('张三', '评委B', 26, 25), mk('张三', '评委C', 27, 28),
    mk('李四', '评委A', 22, 21), mk('李四', '评委B', 23, 22),
    mk('王五', '评委A', 25, 24), mk('王五', '评委B', 24, 25), mk('王五', '评委C', 26, 26)
  ], { 'Prefer': 'return=representation' });
  check('评委提交评分 (匿名 INSERT scores)', sc.status === 201 && sc.data.length === 8, 'HTTP ' + sc.status);

  // 6. 唯一约束：同一评委对同一选手重复提交应被拒绝
  const dup = await req('POST', '/scores', [mk('张三', '评委A', 30, 30)]);
  const dupBlocked = dup.status === 409 || (dup.data && dup.data.code === '23505');
  check('重复评分被唯一约束拦截 (UNIQUE 生效)', dupBlocked, 'HTTP ' + dup.status + ' ' + (dup.data && dup.data.code || ''));

  // 7. 更新评分（模拟评委修改）
  const upd = await req('PATCH', '/scores?event_id=eq.' + eventId + '&speaker_id=eq.' + sid['张三'] + '&judge_name=eq.' + encodeURIComponent('评委A'),
    { scores: { d1: 29, d2: 28 }, updated_at: new Date().toISOString() },
    { 'Prefer': 'return=representation' });
  check('评委更新自己的评分 (匿名 UPDATE)', upd.status === 200 && upd.data.length === 1, 'HTTP ' + upd.status);

  // 8. 读取全部评分
  const all = await req('GET', '/scores?event_id=eq.' + eventId);
  check('读取全部评分', all.status === 200 && all.data.length === 8, all.data.length + ' 条');

  // 9. 删除单条评分（模拟选手被删时清理）
  const del = await req('DELETE', '/scores?event_id=eq.' + eventId + '&speaker_id=eq.' + sid['王五'] + '&judge_name=eq.' + encodeURIComponent('评委C'),
    null, { 'Prefer': 'return=representation' });
  check('删除单条评分 (匿名 DELETE)', del.status === 200 && del.data.length === 1, 'HTTP ' + del.status);

  // 10. app_config 表读写
  const cfgW = await req('POST', '/app_config',
    { cfg_key: '__selftest__', cfg_value: 'ok', updated_at: new Date().toISOString() },
    { 'Prefer': 'resolution=merge-duplicates,return=representation' });
  check('写入配置 (upsert app_config)', cfgW.status === 201 || cfgW.status === 200, 'HTTP ' + cfgW.status);
  const cfgR = await req('GET', '/app_config?cfg_key=eq.__selftest__');
  check('读取配置', cfgR.status === 200 && cfgR.data.length === 1 && cfgR.data[0].cfg_value === 'ok', 'HTTP ' + cfgR.status);

  // 11. 更新活动配置（管理端改维度）
  const evUpd = await req('PATCH', '/events?id=eq.' + eventId,
    { status: 'closed', settings: { dropHighest: true, dropLowest: true, dropCount: 1 } },
    { 'Prefer': 'return=representation' });
  check('更新活动状态与规则 (匿名 UPDATE events)', evUpd.status === 200 && evUpd.data[0].status === 'closed', 'HTTP ' + evUpd.status);

  console.log('\n--- 数据清理 ---');
  await req('DELETE', '/scores?event_id=eq.' + eventId);
  await req('DELETE', '/speakers?event_id=eq.' + eventId);
  await req('DELETE', '/events?id=eq.' + eventId);
  await req('DELETE', '/app_config?cfg_key=eq.__selftest__');
  const finalChk = await req('GET', '/events?id=eq.' + eventId);
  check('清理测试数据', finalChk.data.length === 0, '剩余 ' + finalChk.data.length + ' 条');

  console.log('\n========================================');
  console.log('端到端链路：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });