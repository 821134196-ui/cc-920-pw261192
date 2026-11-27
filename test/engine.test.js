import test from 'node:test';
import assert from 'node:assert/strict';

import { BudgetEngine, DEMO_TIMES, DEMO_WINDOW } from '../src/engine.js';
import {
  buildInitialReport,
  buildLateRevisionReport,
  buildTooLateReport,
} from '../src/demo.js';

function checkoutCritical(engine, scope = 'live') {
  return engine.getBudgetView(DEMO_WINDOW.id, '/checkout', 'critical', { scope });
}

test('成功标准按路由和请求等级区分', () => {
  const engine = new BudgetEngine();
  const receivedAt = '2026-11-27T10:03:00.000Z';
  engine.ingestReport({
    reportId: 'policy-difference',
    receivedAt,
    windowId: DEMO_WINDOW.id,
    records: [
      { requestId: 'critical-4xx', route: '/checkout', tier: 'critical', status: 429, latencyMs: 80 },
      { requestId: 'standard-4xx', route: '/checkout', tier: 'standard', status: 429, latencyMs: 120 },
      { requestId: 'search-slow', route: '/search', tier: 'critical', status: 200, latencyMs: 180 },
      { requestId: 'batch-slow-ok', route: '/reports/export', tier: 'batch', status: 200, latencyMs: 4900 },
    ],
  });

  const critical = engine.getBudgetView(DEMO_WINDOW.id, '/checkout', 'critical');
  const standard = engine.getBudgetView(DEMO_WINDOW.id, '/checkout', 'standard');
  const search = engine.getBudgetView(DEMO_WINDOW.id, '/search', 'critical');
  const batch = engine.getBudgetView(DEMO_WINDOW.id, '/reports/export', 'batch');

  assert.equal(critical.numerator, 1);
  assert.equal(standard.numerator, 0);
  assert.equal(search.numerator, 1);
  assert.equal(batch.numerator, 0);
});

test('重复 reportId 上报不会重复消耗预算或创建新版本', () => {
  const engine = new BudgetEngine();
  const initial = buildInitialReport();
  const first = engine.ingestReport(initial);
  const before = checkoutCritical(engine);

  const duplicate = engine.ingestReport({
    ...buildInitialReport(),
    receivedAt: DEMO_TIMES.duplicateReceivedAt,
  });
  const after = checkoutCritical(engine);

  assert.equal(first.status, 'accepted');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.duplicate, true);
  assert.equal(after.numerator, before.numerator);
  assert.equal(after.denominator, before.denominator);
  assert.equal(after.dataVersion, before.dataVersion);
  assert.equal(engine.records.size, 560);
  assert.equal(engine.reports.size, 1);
});

test('新 reportId 中重复出现相同 requestId 也不会双重计算', () => {
  const engine = new BudgetEngine();
  engine.ingestReport({
    reportId: 'first',
    receivedAt: DEMO_TIMES.initialReceivedAt,
    windowId: DEMO_WINDOW.id,
    records: [
      { requestId: 'req-1', route: '/checkout', tier: 'critical', status: 500, latencyMs: 100 },
      { requestId: 'req-2', route: '/checkout', tier: 'critical', status: 200, latencyMs: 100 },
    ],
  });

  const result = engine.ingestReport({
    reportId: 'second-with-duplicate-request',
    receivedAt: DEMO_TIMES.revisedReceivedAt,
    windowId: DEMO_WINDOW.id,
    records: [
      { requestId: 'req-1', route: '/checkout', tier: 'critical', status: 500, latencyMs: 100 },
      { requestId: 'req-3', route: '/checkout', tier: 'critical', status: 200, latencyMs: 100 },
    ],
  });

  const view = checkoutCritical(engine);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.duplicateRequestIds, ['req-1']);
  assert.equal(view.denominator, 3);
  assert.equal(view.numerator, 1);
});

test('宽限内迟到记录生成新版本，并把严重告警修订为预警', () => {
  const engine = new BudgetEngine();
  engine.ingestReport(buildInitialReport());
  const v1 = checkoutCritical(engine);
  assert.equal(v1.numerator, 2);
  assert.equal(v1.denominator, 40);
  assert.equal(v1.level, 'critical');
  assert.match(v1.dataVersion, /^r1·/);

  engine.ingestReport(buildLateRevisionReport());
  const v2 = checkoutCritical(engine);
  assert.equal(v2.numerator, 2);
  assert.equal(v2.denominator, 240);
  assert.equal(v2.level, 'warning');
  assert.match(v2.dataVersion, /^r2·/);
  assert.notEqual(v2.sliceHash, v1.sliceHash);
  assert.equal(v2.versionHistory.length, 2);
});

test('结算冻结正式分子分母和版本；过晚数据只进更正记录，不静默改判', () => {
  const engine = new BudgetEngine();
  engine.ingestReport(buildInitialReport());
  engine.ingestReport(buildLateRevisionReport());

  const settled = engine.settleWindow(DEMO_WINDOW.id, DEMO_TIMES.settleAt);
  assert.equal(settled.status, 'settled');

  const officialBeforeLate = checkoutCritical(engine, 'official');
  assert.equal(officialBeforeLate.scope, 'official-settled');
  assert.equal(officialBeforeLate.numerator, 2);
  assert.equal(officialBeforeLate.denominator, 240);
  assert.equal(officialBeforeLate.level, 'warning');
  assert.match(officialBeforeLate.dataVersion, /^r2·/);

  const opsMessageCountAfterSettle = engine.messages.length;
  assert.ok(opsMessageCountAfterSettle >= 1);
  assert.equal(engine.messages.filter((m) => m.kind === 'settled-alert').length, opsMessageCountAfterSettle);

  const late = engine.ingestReport(buildTooLateReport());
  assert.equal(late.correctionIds.length, 1);

  const officialAfterLate = checkoutCritical(engine, 'official');
  const liveAfterLate = checkoutCritical(engine, 'live');

  assert.equal(officialAfterLate.numerator, 2);
  assert.equal(officialAfterLate.denominator, 240);
  assert.equal(officialAfterLate.level, 'warning');
  assert.equal(officialAfterLate.dataVersion, officialBeforeLate.dataVersion);

  assert.equal(liveAfterLate.numerator, 6);
  assert.equal(liveAfterLate.denominator, 250);
  assert.equal(liveAfterLate.level, 'critical');
  assert.match(liveAfterLate.dataVersion, /^r3·/);

  assert.equal(engine.messages.length, opsMessageCountAfterSettle, '迟到数据本身不能自动产生或覆盖运营告警');
  const correction = engine.corrections.get(late.correctionIds[0]);
  assert.equal(correction.status, 'recorded');
  assert.equal(correction.diff.fromLevel, 'warning');
  assert.equal(correction.diff.toLevel, 'critical');

  const advisory = engine.publishCorrectionAdvisory(correction.id, { at: DEMO_TIMES.advisoryAt });
  assert.equal(advisory.status, 'published');
  assert.equal(engine.messages.length, opsMessageCountAfterSettle + 1);
  assert.equal(engine.messages.at(-1).kind, 'correction-advisory');
  assert.equal(engine.messages.at(-1).supersedesSettlement, false);

  const officialAfterAdvisory = checkoutCritical(engine, 'official');
  assert.equal(officialAfterAdvisory.level, 'warning');
  assert.equal(officialAfterAdvisory.dataVersion, officialBeforeLate.dataVersion);
});

test('重复结算不会重复发布告警', () => {
  const engine = new BudgetEngine();
  engine.ingestReport(buildInitialReport());
  engine.ingestReport(buildLateRevisionReport());
  engine.settleWindow(DEMO_WINDOW.id, DEMO_TIMES.settleAt);
  const messagesAfterFirst = engine.messages.length;

  const replay = engine.settleWindow(DEMO_WINDOW.id, DEMO_TIMES.settleAt);
  assert.equal(replay.status, 'already-settled');
  assert.equal(replay.duplicate, true);
  assert.equal(engine.messages.length, messagesAfterFirst);
});

test('未到水位线不能结算', () => {
  const engine = new BudgetEngine();
  engine.ingestReport(buildInitialReport());
  assert.throws(
    () => engine.settleWindow(DEMO_WINDOW.id, '2026-11-27T10:06:30.000Z'),
    /尚未到结算时间/,
  );
});
