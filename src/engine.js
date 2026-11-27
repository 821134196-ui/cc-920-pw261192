// 零依赖错误预算引擎：成功策略、幂等入账、版本切片、结算冻结与更正记录。
// 该模块不访问 DOM，可同时被浏览器和 Node 测试引用。

export const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  // 已消耗错误预算比例：>=50% 预警，>=100% 告警。
  warningConsumedRatio: 0.5,
});

export const POLICY_MATRIX = Object.freeze([
  {
    route: '/checkout',
    method: 'POST',
    tier: 'critical',
    tierLabel: '关键交易',
    target: 0.99,
    maxLatencyMs: 200,
    successStatusBelow: 400,
    criteria: ['HTTP 状态码 < 400', '延迟 ≤ 200ms'],
    rationale: '支付/下单关键旅程：4xx 也表示用户未完成交易，因此计入失败。',
  },
  {
    route: '/checkout',
    method: 'POST',
    tier: 'standard',
    tierLabel: '普通下单',
    target: 0.995,
    maxLatencyMs: 500,
    successStatusBelow: 500,
    criteria: ['HTTP 状态码 < 500', '延迟 ≤ 500ms'],
    rationale: '普通下单：4xx 多为客户端请求问题，只统计 5xx 与超时。',
  },
  {
    route: '/search',
    method: 'GET',
    tier: 'critical',
    tierLabel: '核心搜索',
    target: 0.999,
    maxLatencyMs: 150,
    successStatusBelow: 500,
    criteria: ['HTTP 状态码 < 500', '延迟 ≤ 150ms'],
    rationale: '核心搜索要求低延迟；超过 150ms 即使返回 200 也视为 SLO 失败。',
  },
  {
    route: '/search',
    method: 'GET',
    tier: 'standard',
    tierLabel: '一般查询',
    target: 0.995,
    maxLatencyMs: 400,
    successStatusBelow: 500,
    criteria: ['HTTP 状态码 < 500', '延迟 ≤ 400ms'],
    rationale: '一般查询采用更宽松的延迟门槛。',
  },
  {
    route: '/reports/export',
    method: 'POST',
    tier: 'batch',
    tierLabel: '异步报表',
    target: 0.98,
    maxLatencyMs: 5000,
    successStatusBelow: 500,
    criteria: ['HTTP 状态码 < 500', '延迟 ≤ 5000ms'],
    rationale: '异步批量导出允许更长处理时间和更低的月度 SLO。',
  },
]);

export const DEMO_WINDOW = Object.freeze({
  id: 'W-1000-1005',
  label: '10:00–10:05 UTC',
  startAt: '2026-11-27T10:00:00.000Z',
  endAt: '2026-11-27T10:05:00.000Z',
  allowedLatenessMs: 2 * 60_000,
});

export const DEMO_TIMES = Object.freeze({
  initialReceivedAt: '2026-11-27T10:05:30.000Z',
  duplicateReceivedAt: '2026-11-27T10:06:05.000Z',
  revisedReceivedAt: '2026-11-27T10:06:40.000Z',
  settleAt: '2026-11-27T10:07:00.000Z',
  lateReceivedAt: '2026-11-27T10:08:30.000Z',
  advisoryAt: '2026-11-27T10:09:10.000Z',
});

export function budgetKey(windowId, route, tier) {
  return `${windowId}||${route}||${tier}`;
}

export function parseBudgetKey(key) {
  const [windowId, route, tier] = key.split('||');
  return { windowId, route, tier };
}

export function findPolicy(route, tier, policies = POLICY_MATRIX) {
  return policies.find((p) => p.route === route && p.tier === tier) ?? null;
}

export function evaluateSuccess(raw, policy) {
  if (!policy) {
    return { outcome: 'unclassified', isError: false, failureReasons: ['没有匹配的路由/等级成功策略'] };
  }
  const failureReasons = [];
  const status = Number(raw.status);
  const latencyMs = Number(raw.latencyMs);

  if (!Number.isInteger(status) || status < 100 || status > 599) {
    failureReasons.push(`状态码无效：${raw.status}`);
  } else if (status >= policy.successStatusBelow) {
    failureReasons.push(`HTTP ${status} ≥ ${policy.successStatusBelow}`);
  }

  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    failureReasons.push(`延迟无效：${raw.latencyMs}`);
  } else if (latencyMs > policy.maxLatencyMs) {
    failureReasons.push(`延迟 ${latencyMs}ms > ${policy.maxLatencyMs}ms`);
  }

  return failureReasons.length > 0
    ? { outcome: 'error', isError: true, failureReasons }
    : { outcome: 'success', isError: false, failureReasons: [] };
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortDeep(value[k])]),
    );
  }
  return value;
}

export function canonicalStringify(value) {
  return JSON.stringify(sortDeep(value));
}

// cyrb53：同步、短哈希，足够做界面上的数据版本指纹，不用于安全用途。
export function shortHash(value) {
  const str = canonicalStringify(value);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(16).padStart(14, '0').slice(-10);
}

export function classifyBudgetLevel(view, thresholds = DEFAULT_ALERT_THRESHOLDS) {
  if (!view || view.denominator === 0) return 'no-data';
  if (view.allowedErrors === 0) return view.numerator > 0 ? 'critical' : 'healthy';
  const ratio = view.consumedRatio;
  if (ratio >= 1) return 'critical';
  if (ratio >= thresholds.warningConsumedRatio) return 'warning';
  return 'healthy';
}

export function formatPercent(ratio, digits = 1) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class BudgetEngine {
  constructor(options = {}) {
    this.policies = options.policies ?? POLICY_MATRIX;
    this.thresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...(options.thresholds ?? {}) };
    this.defaultAllowedLatenessMs = options.allowedLatenessMs ?? 2 * 60_000;
    this.windows = new Map((options.windows ?? [DEMO_WINDOW]).map((w) => [w.id, { ...w }]));

    this.records = new Map();
    this.reports = new Map();
    this.reportOrder = [];
    this.sliceRevisions = new Map();
    this.versionHistory = new Map();
    this.audit = [];
    this.messages = [];
    this.corrections = new Map();
    this.correctionOrder = [];
    this.sequence = 0;
  }

  nextId(prefix) {
    this.sequence += 1;
    return `${prefix}_${String(this.sequence).padStart(4, '0')}`;
  }

  log(type, payload = {}, at = payload.at ?? new Date().toISOString()) {
    const event = { id: this.nextId('evt'), seq: this.sequence, type, at, ...payload };
    this.audit.push(event);
    return event;
  }

  getWindow(windowId) {
    return this.windows.get(windowId) ?? null;
  }

  cutoffFor(window) {
    const lateness = window.allowedLatenessMs ?? this.defaultAllowedLatenessMs;
    return Date.parse(window.endAt) + lateness;
  }

  classifyArrival(window, receivedAt) {
    const receivedMs = Date.parse(receivedAt);
    const endMs = Date.parse(window.endAt);
    const cutoffMs = this.cutoffFor(window);
    const delayMs = receivedMs - endMs;
    let timeliness;
    if (receivedMs <= endMs) timeliness = 'on-time';
    else if (receivedMs <= cutoffMs) timeliness = 'late-within-grace';
    else timeliness = 'late-beyond-cutoff';

    return {
      timeliness,
      delayMs,
      cutoffAt: new Date(cutoffMs).toISOString(),
      admitted: receivedMs <= cutoffMs,
    };
  }

  prepareRecord(raw, reportContext) {
    const windowId = raw.windowId ?? reportContext.windowId;
    const window = this.getWindow(windowId);
    if (!window) {
      return { conflict: true, conflictReason: `未知窗口：${windowId}`, raw };
    }

    const eventAt = raw.eventAt ?? window.startAt;
    const eventMs = Date.parse(eventAt);
    const inWindow =
      Number.isFinite(eventMs) &&
      eventMs >= Date.parse(window.startAt) &&
      eventMs < Date.parse(window.endAt);

    const policy = findPolicy(raw.route, raw.tier, this.policies);
    const success = evaluateSuccess(raw, policy);
    const arrival = this.classifyArrival(window, reportContext.receivedAt);
    const eligible = Boolean(policy) && inWindow && success.outcome !== 'unclassified';

    const recordHash = shortHash({
      requestId: raw.requestId,
      eventAt,
      route: raw.route,
      tier: raw.tier,
      status: Number(raw.status),
      latencyMs: Number(raw.latencyMs),
    });

    const record = {
      requestId: raw.requestId,
      windowId,
      eventAt,
      receivedAt: reportContext.receivedAt,
      reportId: reportContext.reportId,
      route: raw.route,
      tier: raw.tier,
      status: Number(raw.status),
      latencyMs: Number(raw.latencyMs),
      eventAtValid: inWindow,
      policyMatched: Boolean(policy),
      eligible,
      exclusionReason: !policy
        ? 'no_success_policy'
        : !inWindow
          ? 'event_outside_window'
          : null,
      outcome: eligible ? success.outcome : 'excluded',
      failureReasons: success.failureReasons,
      admitted: arrival.admitted,
      timeliness: arrival.timeliness,
      delayMs: arrival.delayMs,
      recordHash,
    };

    return { conflict: false, record, recordHash };
  }

  ingestReport(input = {}) {
    const reportId = input.reportId;
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    const windowId = input.windowId;
    const incoming = Array.isArray(input.records) ? input.records : [];

    if (!reportId || typeof reportId !== 'string') {
      const error = new Error('reportId 是必填的幂等键');
      error.code = 'REPORT_ID_REQUIRED';
      throw error;
    }

    const contentHash = shortHash(
      incoming.map((r) => ({
        requestId: r.requestId,
        eventAt: r.eventAt,
        windowId: r.windowId,
        route: r.route,
        tier: r.tier,
        status: r.status,
        latencyMs: r.latencyMs,
      })),
    );

    // 1) 上报批次幂等：同一 reportId + 相同内容永远只处理一次。
    const existingReport = this.reports.get(reportId);
    if (existingReport) {
      if (existingReport.contentHash !== contentHash) {
        const result = {
          status: 'conflict',
          code: 'IDEMPOTENCY_KEY_PAYLOAD_CONFLICT',
          reportId,
          message: '相同 reportId 的报文内容不一致；已拒绝，未写入任何记录。',
        };
        this.log('report.conflict', result, receivedAt);
        return result;
      }

      const result = {
        status: 'duplicate',
        duplicate: true,
        reportId,
        contentHash,
        firstAcceptedAt: existingReport.acceptedAt,
        newRecordCount: 0,
        message: '重复上报已被幂等层拦截，分子、分母和数据版本均未变化。',
      };
      this.log('report.duplicate_blocked', { reportId, contentHash }, receivedAt);
      return result;
    }

    if (incoming.length === 0) {
      const error = new Error('records 不能为空');
      error.code = 'RECORDS_REQUIRED';
      throw error;
    }

    // 2) 原子预检：缺少 requestId、批次内冲突、与已存 requestId 内容冲突都不写入。
    const batchIds = new Set();
    const prepared = [];
    const duplicateRequestIds = [];
    const conflicts = [];

    for (const raw of incoming) {
      if (!raw.requestId) {
        conflicts.push({ requestId: null, reason: 'requestId 必填' });
        continue;
      }
      if (batchIds.has(raw.requestId)) {
        conflicts.push({ requestId: raw.requestId, reason: '同一批次内 requestId 重复且内容可能冲突' });
        continue;
      }
      batchIds.add(raw.requestId);

      const preparedItem = this.prepareRecord(raw, { reportId, receivedAt, windowId });
      if (preparedItem.conflict) {
        conflicts.push({ requestId: raw.requestId, reason: preparedItem.conflictReason });
        continue;
      }

      const existingRecord = this.records.get(raw.requestId);
      if (existingRecord) {
        if (existingRecord.recordHash === preparedItem.recordHash) {
          duplicateRequestIds.push(raw.requestId);
          continue;
        }
        conflicts.push({
          requestId: raw.requestId,
          reason: 'requestId 已存在但报文不同；如需改判请走显式更正流程',
        });
        continue;
      }

      prepared.push(preparedItem);
    }

    if (conflicts.length > 0) {
      const result = {
        status: 'conflict',
        code: 'RECORD_CONFLICT',
        reportId,
        conflicts,
        message: '预检发现冲突，整批未入账。',
      };
      this.log('report.conflict', { reportId, conflicts }, receivedAt);
      return result;
    }

    const newRecords = prepared.map((p) => p.record);
    const touchedKeys = [...new Set(newRecords.filter((r) => r.eligible).map((r) => budgetKey(r.windowId, r.route, r.tier)))];

    // 记录修订前结论，用于演示实时估值/告警等级如何变化。
    const beforeByKey = new Map();
    for (const key of touchedKeys) {
      const { windowId: wId, route, tier } = parseBudgetKey(key);
      beforeByKey.set(key, this.getBudgetView(wId, route, tier, { scope: 'live' }));
    }

    // 3) 提交。
    const receipt = {
      reportId,
      contentHash,
      receivedAt,
      acceptedAt: receivedAt,
      recordCount: incoming.length,
      newRecordCount: newRecords.length,
      duplicateRequestIds,
      windowId: windowId ?? null,
      timeliness: null,
      correctionOnlyCount: 0,
    };

    for (const record of newRecords) {
      this.records.set(record.requestId, record);
    }
    this.reports.set(reportId, receipt);
    this.reportOrder.push(reportId);

    const revisionEvents = [];
    for (const key of touchedKeys) {
      const currentRevision = this.sliceRevisions.get(key) ?? 0;
      const revision = currentRevision + 1;
      this.sliceRevisions.set(key, revision);

      const { windowId: wId, route, tier } = parseBudgetKey(key);
      const after = this.getBudgetView(wId, route, tier, { scope: 'live' });
      if (!this.versionHistory.has(key)) this.versionHistory.set(key, []);
      const versionEntry = {
        revision,
        dataVersion: `r${revision}·${after.sliceHash}`,
        sliceHash: after.sliceHash,
        reportId,
        at: receivedAt,
        numerator: after.numerator,
        denominator: after.denominator,
        consumedRatio: after.consumedRatio,
        level: after.level,
        admittedToSettlement: after.admittedNumerator === after.numerator && after.admittedDenominator === after.denominator,
      };
      this.versionHistory.get(key).push(versionEntry);
      revisionEvents.push({ key, before: beforeByKey.get(key), after, versionEntry });
    }

    // 4) 超过结算宽限期或到达于结算后的记录，只形成更正候选，不回写正式快照。
    const correctionOnlyRecords = newRecords.filter((r) => r.eligible && (!r.admitted || this.windows.get(r.windowId)?.status === 'settled'));
    receipt.correctionOnlyCount = correctionOnlyRecords.length;
    if (newRecords[0]?.windowId) {
      const window = this.windows.get(newRecords[0].windowId);
      receipt.timeliness = this.classifyArrival(window, receivedAt).timeliness;
    }

    const correctionKeys = [...new Set(correctionOnlyRecords.map((r) => budgetKey(r.windowId, r.route, r.tier)))];
    const correctionIds = [];
    for (const key of correctionKeys) {
      const correction = this.createCorrectionRecord(key, reportId, receivedAt, correctionOnlyRecords);
      correctionIds.push(correction.id);
    }

    for (const change of revisionEvents) {
      const beforeLevel = change.before?.level ?? 'no-data';
      const afterLevel = change.after.level;
      if (beforeLevel !== afterLevel || change.versionEntry.revision === 1) {
        const settled = this.windows.get(change.after.windowId)?.status === 'settled';
        this.log(
          settled || correctionKeys.includes(change.key) ? 'estimate.correction_preview_changed' : 'estimate.revised',
          {
            reportId,
            budgetKey: change.key,
            fromLevel: beforeLevel,
            toLevel: afterLevel,
            from: { numerator: change.before?.numerator ?? 0, denominator: change.before?.denominator ?? 0 },
            to: { numerator: change.after.numerator, denominator: change.after.denominator },
            dataVersion: change.versionEntry.dataVersion,
            channel: settled || correctionKeys.includes(change.key) ? 'dashboard-correction-only' : 'dashboard-live-estimate',
            officialAlertMutated: false,
          },
          receivedAt,
        );
      }
    }

    this.log(
      'report.accepted',
      {
        reportId,
        contentHash,
        newRecordCount: newRecords.length,
        duplicateRequestCount: duplicateRequestIds.length,
        correctionOnlyCount: correctionOnlyRecords.length,
        touchedKeys,
        correctionIds,
      },
      receivedAt,
    );

    return {
      status: 'accepted',
      duplicate: false,
      reportId,
      contentHash,
      newRecordCount: newRecords.length,
      duplicateRequestIds,
      correctionIds,
      touchedKeys,
      message: `已入账 ${newRecords.length} 条；重复 requestId ${duplicateRequestIds.length} 条未重复计算。`,
    };
  }

  createCorrectionRecord(key, reportId, receivedAt, correctionOnlyRecords) {
    const { windowId, route, tier } = parseBudgetKey(key);
    const window = this.getWindow(windowId);
    const live = this.getBudgetView(windowId, route, tier, { scope: 'live' });
    const admitted = this.getBudgetView(windowId, route, tier, { scope: 'admitted' });
    const official = window.settlement?.snapshots?.[key] ? clone(window.settlement.snapshots[key]) : null;
    const baseline = official ?? admitted;
    const id = this.nextId('corr');

    const correction = {
      id,
      key,
      windowId,
      route,
      tier,
      reportId,
      receivedAt,
      createdAt: receivedAt,
      reason: window.status === 'settled' ? 'post-settlement-late-data' : 'beyond-admission-cutoff',
      status: 'recorded',
      recordIds: correctionOnlyRecords.filter((r) => budgetKey(r.windowId, r.route, r.tier) === key).map((r) => r.requestId),
      officialSnapshot: official,
      admittedSnapshot: admitted,
      candidateSnapshot: live,
      diff: {
        numeratorDelta: live.numerator - (baseline?.numerator ?? 0),
        denominatorDelta: live.denominator - (baseline?.denominator ?? 0),
        fromLevel: baseline?.level ?? 'no-data',
        toLevel: live.level,
        fromDataVersion: baseline?.dataVersion ?? null,
        toDataVersion: live.dataVersion,
      },
      advisoryId: null,
    };

    this.corrections.set(id, correction);
    this.correctionOrder.push(id);
    this.log(
      'correction.recorded',
      {
        correctionId: id,
        budgetKey: key,
        reportId,
        reason: correction.reason,
        diff: correction.diff,
        officialAlertMutated: false,
      },
      receivedAt,
    );
    return correction;
  }

  getBudgetView(windowId, route, tier, options = {}) {
    const scope = options.scope ?? 'live';
    const key = budgetKey(windowId, route, tier);
    const window = this.getWindow(windowId);

    if ((scope === 'official' || scope === 'settled') && window?.settlement?.snapshots?.[key]) {
      return clone(window.settlement.snapshots[key]);
    }

    const policy = findPolicy(route, tier, this.policies);
    const allMatching = [...this.records.values()].filter(
      (r) => r.windowId === windowId && r.route === route && r.tier === tier,
    );

    const included = allMatching
      .filter((r) => r.eligible)
      .filter((r) => scope !== 'admitted' && scope !== 'settled' ? true : r.admitted)
      .sort((a, b) => a.requestId.localeCompare(b.requestId));

    const excluded = allMatching.filter((r) => !r.eligible);
    const numerator = included.filter((r) => r.outcome === 'error').length;
    const denominator = included.length;
    const successCount = denominator - numerator;
    const target = policy?.target ?? null;
    const allowedErrors = target === null ? null : denominator * (1 - target);
    const remainingBudget = allowedErrors === null ? null : allowedErrors - numerator;
    const consumedRatio =
      allowedErrors === null || allowedErrors === 0
        ? numerator > 0
          ? Number.POSITIVE_INFINITY
          : 0
        : numerator / allowedErrors;
    const finiteConsumedRatio = Number.isFinite(consumedRatio) ? consumedRatio : null;

    const revision = this.sliceRevisions.get(key) ?? 0;
    const sliceHash = shortHash(
      included.map((r) => ({
        requestId: r.requestId,
        outcome: r.outcome,
        status: r.status,
        latencyMs: r.latencyMs,
        eventAt: r.eventAt,
        reasons: r.failureReasons,
      })),
    );
    const historyForSlice = this.versionHistory.get(key) ?? [];
    const matchingHistoryEntry = [...historyForSlice].reverse().find((entry) => entry.sliceHash === sliceHash);
    const effectiveRevision = matchingHistoryEntry?.revision ?? revision;

    const reasonCounts = {};
    for (const record of included.filter((r) => r.outcome === 'error')) {
      for (const reason of record.failureReasons) {
        const reasonKey = reason.replace(/\s*\d+ms?.*$/, '').replace(/HTTP \d+.*/, 'HTTP 状态码不达标');
        reasonCounts[reasonKey] = (reasonCounts[reasonKey] ?? 0) + 1;
      }
    }

    const sourceReports = [...new Set(included.map((r) => r.reportId))].map((reportId) => {
      const report = this.reports.get(reportId);
      return {
        reportId,
        contentHash: report?.contentHash ?? null,
        receivedAt: report?.receivedAt ?? null,
        timeliness: report?.timeliness ?? null,
      };
    });

    const view = {
      key,
      windowId,
      route,
      tier,
      policy,
      scope,
      numerator,
      denominator,
      successCount,
      target,
      allowedErrors,
      remainingBudget,
      consumedRatio: finiteConsumedRatio,
      overBudget: remainingBudget !== null && remainingBudget < 0,
      level: 'no-data',
      revision: effectiveRevision,
      currentRevision: revision,
      sliceHash,
      dataVersion: `r${effectiveRevision}·${sliceHash}`,
      recordIds: included.map((r) => r.requestId),
      errorRecords: included.filter((r) => r.outcome === 'error').map((r) => clone(r)),
      records: included.map((r) => clone(r)),
      excludedRecords: excluded.map((r) => clone(r)),
      reasonCounts,
      sourceReports,
      versionHistory: clone(this.versionHistory.get(key) ?? []),
      admittedNumerator: included.filter((r) => r.admitted && r.outcome === 'error').length,
      admittedDenominator: included.filter((r) => r.admitted).length,
    };
    view.level = classifyBudgetLevel(view, this.thresholds);
    return view;
  }

  listBudgetKeys() {
    const keys = new Set();
    for (const record of this.records.values()) {
      if (record.eligible) keys.add(budgetKey(record.windowId, record.route, record.tier));
    }
    return [...keys].sort();
  }

  getConclusions() {
    return this.listBudgetKeys().map((key) => {
      const { windowId, route, tier } = parseBudgetKey(key);
      const live = this.getBudgetView(windowId, route, tier, { scope: 'live' });
      const admitted = this.getBudgetView(windowId, route, tier, { scope: 'admitted' });
      const official = this.getBudgetView(windowId, route, tier, { scope: 'official' });
      const corrections = this.correctionOrder
        .map((id) => this.corrections.get(id))
        .filter((c) => c.key === key);
      return { key, windowId, route, tier, live, admitted, official, corrections };
    });
  }

  settleWindow(windowId, at = new Date().toISOString(), actor = 'scheduled-watermark') {
    const window = this.getWindow(windowId);
    if (!window) {
      const error = new Error(`未知窗口：${windowId}`);
      error.code = 'WINDOW_NOT_FOUND';
      throw error;
    }

    if (window.settlement) {
      this.log('settle.idempotent_replay', { windowId, settlementId: window.settlement.id }, at);
      return {
        status: 'already-settled',
        duplicate: true,
        settlement: clone(window.settlement),
        messages: this.messages.filter((m) => m.settlementId === window.settlement.id),
      };
    }

    const cutoffMs = this.cutoffFor(window);
    if (Date.parse(at) < cutoffMs) {
      const error = new Error(`尚未到结算时间：需在 ${new Date(cutoffMs).toISOString()} 之后结算`);
      error.code = 'SETTLEMENT_NOT_DUE';
      error.details = { cutoffAt: new Date(cutoffMs).toISOString(), requestedAt: at };
      throw error;
    }

    const keys = new Set();
    for (const record of this.records.values()) {
      if (record.windowId === windowId && record.eligible && record.admitted) {
        keys.add(budgetKey(record.windowId, record.route, record.tier));
      }
    }

    const snapshots = {};
    const alerts = {};
    const messageIds = [];
    const settlementId = this.nextId('stl');

    for (const key of [...keys].sort()) {
      const { route, tier } = parseBudgetKey(key);
      const view = this.getBudgetView(windowId, route, tier, { scope: 'admitted' });
      const frozenView = { ...view, scope: 'official-settled', frozenAt: at };
      snapshots[key] = frozenView;

      alerts[key] = {
        key,
        level: view.level,
        rule: `预算消耗 ≥ ${this.thresholds.warningConsumedRatio * 100}% 预警；≥ 100% 告警`,
        dataVersion: frozenView.dataVersion,
        numerator: frozenView.numerator,
        denominator: frozenView.denominator,
        settledAt: at,
      };

      if (view.level === 'warning' || view.level === 'critical') {
        const severity = view.level;
        const message = {
          id: this.nextId('msg'),
          kind: 'settled-alert',
          channel: 'operations',
          severity,
          windowId,
          budgetKey: key,
          settlementId,
          createdAt: at,
          actor,
          official: true,
          supersedes: null,
          title: `${severity === 'critical' ? '正式严重告警' : '正式预警'}：${view.policy.method} ${route} · ${view.policy.tierLabel}`,
          body: `窗口 ${window.label} 已按 ${frozenView.dataVersion} 结算：错误 ${view.numerator}/${view.denominator}，预算消耗 ${(view.consumedRatio * 100).toFixed(1)}%。该结论已冻结，后续迟到数据不会静默改判。`,
        };
        this.messages.push(message);
        messageIds.push(message.id);
      }
    }

    const settlement = {
      id: settlementId,
      windowId,
      settledAt: at,
      actor,
      cutoffAt: new Date(cutoffMs).toISOString(),
      algorithmVersion: 'error-budget-engine-v1',
      alertRule: alerts[Object.keys(alerts)[0]]?.rule ?? 'budget-consumption',
      snapshots,
      alerts,
      messageIds,
    };

    window.status = 'settled';
    window.settlement = settlement;

    this.log(
      'window.settled',
      {
        windowId,
        settlementId,
        snapshotKeys: Object.keys(snapshots),
        messageIds,
        actor,
      },
      at,
    );
    this.log(
      'operations.alert_published_once',
      { windowId, settlementId, messageIds, note: '每个结算告警只生成一条运营消息' },
      at,
    );

    return { status: 'settled', duplicate: false, settlement: clone(settlement), messages: clone(this.messages.filter((m) => messageIds.includes(m.id))) };
  }

  publishCorrectionAdvisory(correctionId, input = {}) {
    const correction = this.corrections.get(correctionId);
    if (!correction) {
      const error = new Error(`未知更正记录：${correctionId}`);
      error.code = 'CORRECTION_NOT_FOUND';
      throw error;
    }

    const at = input.at ?? new Date().toISOString();
    const operator = input.operator ?? 'ops-oncall';
    const note = input.note ?? '值班同学显式复核迟到数据后发布更正通告。';

    if (correction.status === 'advisory-published') {
      return {
        status: 'duplicate',
        duplicate: true,
        correction: clone(correction),
        message: clone(this.messages.find((m) => m.id === correction.advisoryMessageId) ?? null),
      };
    }

    const message = {
      id: this.nextId('msg'),
      kind: 'correction-advisory',
      channel: 'operations',
      severity: correction.candidateSnapshot.level,
      windowId: correction.windowId,
      budgetKey: correction.key,
      correctionId,
      createdAt: at,
      actor: operator,
      official: true,
      explicitCorrection: true,
      supersedesSettlement: false,
      title: `人工更正通告：${correction.route} · ${correction.tier}（不覆盖原结算）`,
      body: `过晚报告 ${correction.reportId} 已留在更正台账。若采纳候选版本 ${correction.diff.toDataVersion}，结论将由 ${correction.diff.fromLevel} 变为 ${correction.diff.toLevel}（${correction.diff.numeratorDelta >= 0 ? '+' : ''}${correction.diff.numeratorDelta} 错误，${correction.diff.denominatorDelta >= 0 ? '+' : ''}${correction.diff.denominatorDelta} 请求）。正式结算版本 ${correction.diff.fromDataVersion} 仍保持不变；本消息是新增通告，不是静默改判。`,
      note,
    };

    this.messages.push(message);
    correction.status = 'advisory-published';
    correction.advisoryMessageId = message.id;
    correction.advisory = { at, operator, note, messageId: message.id };

    this.log(
      'correction.advisory_published',
      { correctionId, messageId: message.id, officialAlertMutated: false, settlementSuperseded: false },
      at,
    );

    return { status: 'published', duplicate: false, correction: clone(correction), message: clone(message) };
  }

  getDashboardModel() {
    return {
      windows: [...this.windows.values()].map((w) => clone(w)),
      policies: clone(this.policies),
      conclusions: this.getConclusions().map((c) => ({
        ...c,
        live: clone(c.live),
        official: c.official ? clone(c.official) : null,
        corrections: clone(c.corrections),
      })),
      reports: this.reportOrder.map((id) => clone(this.reports.get(id))),
      audit: clone(this.audit),
      messages: clone(this.messages),
      corrections: this.correctionOrder.map((id) => clone(this.corrections.get(id))),
      totals: {
        records: this.records.size,
        reports: this.reports.size,
        duplicateReportAttempts: this.audit.filter((e) => e.type === 'report.duplicate_blocked').length,
        conflicts: this.audit.filter((e) => e.type === 'report.conflict').length,
        corrections: this.correctionOrder.length,
        operationsMessages: this.messages.length,
      },
    };
  }
}
