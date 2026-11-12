// 測「她自己的一天」（src/lane-day.js）：
// 同一天固定、不同天不一樣、時間段落切得對、前半後半會換事做。
import assert from 'node:assert/strict';
import { buildDayPlan, currentActivity, daySeed, formatSelfLine, phaseAt } from '../src/lane-day.js';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const at = (h, m = 0, d = 13) => new Date(2026, 10, d, h, m, 0, 0);

ok('同一天排的作息一樣（確定性）', () => {
  const a = buildDayPlan(at(9));
  const b = buildDayPlan(at(23));
  assert.deepEqual(a, b);
  assert.equal(a.date, '2026-11-13');
  assert.equal(a.weekday, '週五');
});

ok('不同天的種子會變，作息至少有一處不同', () => {
  const seen = new Set();
  for (let d = 1; d <= 14; d += 1) {
    const plan = buildDayPlan(at(12, 0, d));
    seen.add(`${plan.wakeMinute}|${plan.afternoon[0].label}|${plan.evening[0].label}|${plan.night[0].label}`);
  }
  assert.ok(seen.size >= 5, `14 天只排出 ${seen.size} 種作息`);
  assert.notEqual(daySeed(at(12, 0, 13)), daySeed(at(12, 0, 14)));
});

ok('時間段落切得對（含跨午夜）', () => {
  const plan = buildDayPlan(at(12));
  assert.equal(phaseAt(plan, at(0, 30)), 'night');
  assert.equal(phaseAt(plan, at(3, 30)), 'sleep');
  assert.equal(phaseAt(plan, at(9, 0)), 'sleep');
  assert.equal(phaseAt(plan, at(13, 30)), 'noon');
  assert.equal(phaseAt(plan, at(15, 0)), 'afternoon');
  assert.equal(phaseAt(plan, at(19, 0)), 'evening');
  assert.equal(phaseAt(plan, at(23, 30)), 'night');
  assert.equal(phaseAt(plan, at(23, 30)), phaseAt(plan, at(2, 0)));
});

ok('下午前半／後半是不同的事', () => {
  const plan = buildDayPlan(at(12));
  const first = currentActivity(plan, at(15, 0));
  const second = currentActivity(plan, at(17, 0));
  assert.equal(first.phase, 'afternoon');
  assert.equal(second.phase, 'afternoon');
  assert.notEqual(first.label, second.label);
  assert.ok(first.detail.length > 3 && second.detail.length > 3);
});

ok('醒著時自我狀態有內容、睡著時空字', () => {
  const plan = buildDayPlan(at(12));
  const awake = formatSelfLine(currentActivity(plan, at(15, 0)));
  assert.match(awake, /^（你現在.+）$/);
  assert.ok(awake.length > 8);
  assert.equal(formatSelfLine(currentActivity(plan, at(4, 0))), '');
  assert.equal(formatSelfLine(null), '');
});

ok('同一天裡「在干嘛」不會一直同一句', () => {
  const plan = buildDayPlan(at(12));
  const labels = new Set();
  for (let h = 12; h <= 23; h += 1) labels.add(currentActivity(plan, at(h)).label);
  assert.ok(labels.size >= 3, `一天只講得出 ${labels.size} 件事`);
});

console.log(`test-lane-day：${passed} 組通過`);
