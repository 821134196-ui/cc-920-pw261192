import {
  BudgetEngine,
  DEMO_TIMES,
  DEMO_WINDOW,
  POLICY_MATRIX,
  findPolicy,
} from './engine.js';

function isoAt(offsetMs) {
  return new Date(Date.parse(DEMO_WINDOW.startAt) + offsetMs).toISOString();
}

function makeRecord({
  index,
  prefix,
  route,
  tier,
  count,
  windowId = DEMO_WINDOW.id,
  status,
  latencyMs,
  eventOffsetMs,
}) {
  const policy = findPolicy(route, tier, POLICY_MATRIX);
  const safeLatency = Math.max(1, Math.min((policy?.maxLatencyMs ?? 500) - 25, 120));
  const i = String(index).padStart(4, '0');
  return {
    requestId: `${prefix}-${i}`,
    windowId,
    eventAt: isoAt(eventOffsetMs ?? Math.floor((index / Math.max(count, 1)) * 285_000) + 5_000),
    route,
    tier,
    status: status ?? 200,
    latencyMs: latencyMs ?? safeLatency,
  };
}

function makeGroup({ prefix, route, tier, count, errors = {} }) {
  // errors: Map<number, {status?:number, latencyMs?:number}>，index 从 1 开始。
  return Array.from({ length: count }, (_, zeroBased) => {
    const index = zeroBased + 1;
    const override = errors[index] ?? {};
    return makeRecord({
      index,
      prefix,
      route,
      tier,
      count,
      status: override.status,
      latencyMs: override.latencyMs,
      eventOffsetMs: override.eventOffsetMs,
    });
  });
}

export function buildInitialReport() {
  const checkoutCritical = makeGroup({
    prefix: 'chk-c-v1',
    route: '/checkout',
    tier: 'critical',
    count: 40,
    errors: {
      1: { status: 503, latencyMs: 176, eventOffsetMs: 12_000 },
      2: { status: 200, latencyMs: 412, eventOffsetMs: 18_000 },
    },
  });

  const checkoutStandard = makeGroup({
    prefix: 'chk-s-v1',
    route: '/checkout',
    tier: 'standard',
    count: 120,
  });

  const searchCritical = makeGroup({
    prefix: 'src-c-v1',
    route: '/search',
    tier: 'critical',
    count: 160,
  });

  const searchStandard = makeGroup({
    prefix: 'src-s-v1',
    route: '/search',
    tier: 'standard',
    count: 120,
  });

  const reportBatch = makeGroup({
    prefix: 'rpt-b-v1',
    route: '/reports/export',
    tier: 'batch',
    count: 120,
    errors: {
      7: { status: 500, latencyMs: 4_820, eventOffsetMs: 90_000 },
    },
  });

  return {
    reportId: 'rep-1000-initial',
    receivedAt: DEMO_TIMES.initialReceivedAt,
    windowId: DEMO_WINDOW.id,
    records: [
      ...checkoutCritical,
      ...checkoutStandard,
      ...searchCritical,
      ...searchStandard,
      ...reportBatch,
    ],
  };
}

export function buildLateRevisionReport() {
  return {
    reportId: 'rep-1000-late-successes',
    receivedAt: DEMO_TIMES.revisedReceivedAt,
    windowId: DEMO_WINDOW.id,
    records: makeGroup({
      prefix: 'chk-c-v2-late',
      route: '/checkout',
      tier: 'critical',
      count: 200,
    }),
  };
}

export function buildTooLateReport() {
  return {
    reportId: 'rep-1000-too-late-failures',
    receivedAt: DEMO_TIMES.lateReceivedAt,
    windowId: DEMO_WINDOW.id,
    records: makeGroup({
      prefix: 'chk-c-v3-corr',
      route: '/checkout',
      tier: 'critical',
      count: 10,
      errors: {
        1: { status: 500, latencyMs: 166, eventOffsetMs: 41_000 },
        2: { status: 503, latencyMs: 171, eventOffsetMs: 74_000 },
        3: { status: 500, latencyMs: 188, eventOffsetMs: 132_000 },
        4: { status: 200, latencyMs: 388, eventOffsetMs: 211_000 },
      },
    }),
  };
}

export const DEMO_STEPS = Object.freeze([
  {
    id: 'initial',
    label: '上报 v1 初始批次',
    description: '40 条关键交易中 2 条失败，实时估值立即显示严重告警。',
  },
  {
    id: 'duplicate',
    label: '重复上报同一批次',
    description: '完全相同的 reportId 报文再次上报，应被幂等拦截，版本和分子分母不变。',
  },
  {
    id: 'revision',
    label: '上报宽限内迟到批次',
    description: '200 条成功记录补入过去窗口，分母变大，严重告警降为预警。',
  },
  {
    id: 'settle',
    label: '按水位线结算窗口',
    description: '冻结 r2 数据切片与正式预警，运营告警只发布一次。',
  },
  {
    id: 'too-late',
    label: '上报超过截止线的数据',
    description: '这些记录进入更正台账和实时试算，但不能静默改写正式结论。',
  },
  {
    id: 'advisory',
    label: '发布显式人工更正通告',
    description: '新增一条运营通告说明候选改判；原结算告警保持不变。',
  },
]);

export function createDemoEngine({ autoLoadInitial = true } = {}) {
  const engine = new BudgetEngine({ windows: [DEMO_WINDOW] });
  if (autoLoadInitial) {
    engine.ingestReport(buildInitialReport());
  }
  return engine;
}
