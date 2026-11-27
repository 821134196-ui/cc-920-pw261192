(() => {
  // src/engine.js
  var DEFAULT_ALERT_THRESHOLDS = Object.freeze({
    // 已消耗错误预算比例：>=50% 预警，>=100% 告警。
    warningConsumedRatio: 0.5
  });
  var POLICY_MATRIX = Object.freeze([
    {
      route: "/checkout",
      method: "POST",
      tier: "critical",
      tierLabel: "\u5173\u952E\u4EA4\u6613",
      target: 0.99,
      maxLatencyMs: 200,
      successStatusBelow: 400,
      criteria: ["HTTP \u72B6\u6001\u7801 < 400", "\u5EF6\u8FDF \u2264 200ms"],
      rationale: "\u652F\u4ED8/\u4E0B\u5355\u5173\u952E\u65C5\u7A0B\uFF1A4xx \u4E5F\u8868\u793A\u7528\u6237\u672A\u5B8C\u6210\u4EA4\u6613\uFF0C\u56E0\u6B64\u8BA1\u5165\u5931\u8D25\u3002"
    },
    {
      route: "/checkout",
      method: "POST",
      tier: "standard",
      tierLabel: "\u666E\u901A\u4E0B\u5355",
      target: 0.995,
      maxLatencyMs: 500,
      successStatusBelow: 500,
      criteria: ["HTTP \u72B6\u6001\u7801 < 500", "\u5EF6\u8FDF \u2264 500ms"],
      rationale: "\u666E\u901A\u4E0B\u5355\uFF1A4xx \u591A\u4E3A\u5BA2\u6237\u7AEF\u8BF7\u6C42\u95EE\u9898\uFF0C\u53EA\u7EDF\u8BA1 5xx \u4E0E\u8D85\u65F6\u3002"
    },
    {
      route: "/search",
      method: "GET",
      tier: "critical",
      tierLabel: "\u6838\u5FC3\u641C\u7D22",
      target: 0.999,
      maxLatencyMs: 150,
      successStatusBelow: 500,
      criteria: ["HTTP \u72B6\u6001\u7801 < 500", "\u5EF6\u8FDF \u2264 150ms"],
      rationale: "\u6838\u5FC3\u641C\u7D22\u8981\u6C42\u4F4E\u5EF6\u8FDF\uFF1B\u8D85\u8FC7 150ms \u5373\u4F7F\u8FD4\u56DE 200 \u4E5F\u89C6\u4E3A SLO \u5931\u8D25\u3002"
    },
    {
      route: "/search",
      method: "GET",
      tier: "standard",
      tierLabel: "\u4E00\u822C\u67E5\u8BE2",
      target: 0.995,
      maxLatencyMs: 400,
      successStatusBelow: 500,
      criteria: ["HTTP \u72B6\u6001\u7801 < 500", "\u5EF6\u8FDF \u2264 400ms"],
      rationale: "\u4E00\u822C\u67E5\u8BE2\u91C7\u7528\u66F4\u5BBD\u677E\u7684\u5EF6\u8FDF\u95E8\u69DB\u3002"
    },
    {
      route: "/reports/export",
      method: "POST",
      tier: "batch",
      tierLabel: "\u5F02\u6B65\u62A5\u8868",
      target: 0.98,
      maxLatencyMs: 5e3,
      successStatusBelow: 500,
      criteria: ["HTTP \u72B6\u6001\u7801 < 500", "\u5EF6\u8FDF \u2264 5000ms"],
      rationale: "\u5F02\u6B65\u6279\u91CF\u5BFC\u51FA\u5141\u8BB8\u66F4\u957F\u5904\u7406\u65F6\u95F4\u548C\u66F4\u4F4E\u7684\u6708\u5EA6 SLO\u3002"
    }
  ]);
  var DEMO_WINDOW = Object.freeze({
    id: "W-1000-1005",
    label: "10:00\u201310:05 UTC",
    startAt: "2026-11-27T10:00:00.000Z",
    endAt: "2026-11-27T10:05:00.000Z",
    allowedLatenessMs: 2 * 6e4
  });
  var DEMO_TIMES = Object.freeze({
    initialReceivedAt: "2026-11-27T10:05:30.000Z",
    duplicateReceivedAt: "2026-11-27T10:06:05.000Z",
    revisedReceivedAt: "2026-11-27T10:06:40.000Z",
    settleAt: "2026-11-27T10:07:00.000Z",
    lateReceivedAt: "2026-11-27T10:08:30.000Z",
    advisoryAt: "2026-11-27T10:09:10.000Z"
  });
  function budgetKey(windowId, route, tier) {
    return `${windowId}||${route}||${tier}`;
  }
  function parseBudgetKey(key) {
    const [windowId, route, tier] = key.split("||");
    return { windowId, route, tier };
  }
  function findPolicy(route, tier, policies = POLICY_MATRIX) {
    return policies.find((p) => p.route === route && p.tier === tier) ?? null;
  }
  function evaluateSuccess(raw, policy) {
    if (!policy) {
      return { outcome: "unclassified", isError: false, failureReasons: ["\u6CA1\u6709\u5339\u914D\u7684\u8DEF\u7531/\u7B49\u7EA7\u6210\u529F\u7B56\u7565"] };
    }
    const failureReasons = [];
    const status = Number(raw.status);
    const latencyMs = Number(raw.latencyMs);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      failureReasons.push(`\u72B6\u6001\u7801\u65E0\u6548\uFF1A${raw.status}`);
    } else if (status >= policy.successStatusBelow) {
      failureReasons.push(`HTTP ${status} \u2265 ${policy.successStatusBelow}`);
    }
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
      failureReasons.push(`\u5EF6\u8FDF\u65E0\u6548\uFF1A${raw.latencyMs}`);
    } else if (latencyMs > policy.maxLatencyMs) {
      failureReasons.push(`\u5EF6\u8FDF ${latencyMs}ms > ${policy.maxLatencyMs}ms`);
    }
    return failureReasons.length > 0 ? { outcome: "error", isError: true, failureReasons } : { outcome: "success", isError: false, failureReasons: [] };
  }
  function sortDeep(value) {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(
        Object.keys(value).sort().map((k) => [k, sortDeep(value[k])])
      );
    }
    return value;
  }
  function canonicalStringify(value) {
    return JSON.stringify(sortDeep(value));
  }
  function shortHash(value) {
    const str = canonicalStringify(value);
    let h1 = 3735928559;
    let h2 = 1103547991;
    for (let i = 0; i < str.length; i += 1) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
    const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return combined.toString(16).padStart(14, "0").slice(-10);
  }
  function classifyBudgetLevel(view, thresholds = DEFAULT_ALERT_THRESHOLDS) {
    if (!view || view.denominator === 0) return "no-data";
    if (view.allowedErrors === 0) return view.numerator > 0 ? "critical" : "healthy";
    const ratio = view.consumedRatio;
    if (ratio >= 1) return "critical";
    if (ratio >= thresholds.warningConsumedRatio) return "warning";
    return "healthy";
  }
  function formatPercent(ratio, digits = 1) {
    if (ratio === null || ratio === void 0 || Number.isNaN(ratio)) return "\u2014";
    return `${(ratio * 100).toFixed(digits)}%`;
  }
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  var BudgetEngine = class {
    constructor(options = {}) {
      this.policies = options.policies ?? POLICY_MATRIX;
      this.thresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...options.thresholds ?? {} };
      this.defaultAllowedLatenessMs = options.allowedLatenessMs ?? 2 * 6e4;
      this.windows = new Map((options.windows ?? [DEMO_WINDOW]).map((w) => [w.id, { ...w }]));
      this.records = /* @__PURE__ */ new Map();
      this.reports = /* @__PURE__ */ new Map();
      this.reportOrder = [];
      this.sliceRevisions = /* @__PURE__ */ new Map();
      this.versionHistory = /* @__PURE__ */ new Map();
      this.audit = [];
      this.messages = [];
      this.corrections = /* @__PURE__ */ new Map();
      this.correctionOrder = [];
      this.sequence = 0;
    }
    nextId(prefix) {
      this.sequence += 1;
      return `${prefix}_${String(this.sequence).padStart(4, "0")}`;
    }
    log(type, payload = {}, at = payload.at ?? (/* @__PURE__ */ new Date()).toISOString()) {
      const event = { id: this.nextId("evt"), seq: this.sequence, type, at, ...payload };
      this.audit.push(event);
      return event;
    }
    getWindow(windowId) {
      return this.windows.get(windowId) ?? null;
    }
    cutoffFor(window2) {
      const lateness = window2.allowedLatenessMs ?? this.defaultAllowedLatenessMs;
      return Date.parse(window2.endAt) + lateness;
    }
    classifyArrival(window2, receivedAt) {
      const receivedMs = Date.parse(receivedAt);
      const endMs = Date.parse(window2.endAt);
      const cutoffMs = this.cutoffFor(window2);
      const delayMs = receivedMs - endMs;
      let timeliness;
      if (receivedMs <= endMs) timeliness = "on-time";
      else if (receivedMs <= cutoffMs) timeliness = "late-within-grace";
      else timeliness = "late-beyond-cutoff";
      return {
        timeliness,
        delayMs,
        cutoffAt: new Date(cutoffMs).toISOString(),
        admitted: receivedMs <= cutoffMs
      };
    }
    prepareRecord(raw, reportContext) {
      const windowId = raw.windowId ?? reportContext.windowId;
      const window2 = this.getWindow(windowId);
      if (!window2) {
        return { conflict: true, conflictReason: `\u672A\u77E5\u7A97\u53E3\uFF1A${windowId}`, raw };
      }
      const eventAt = raw.eventAt ?? window2.startAt;
      const eventMs = Date.parse(eventAt);
      const inWindow = Number.isFinite(eventMs) && eventMs >= Date.parse(window2.startAt) && eventMs < Date.parse(window2.endAt);
      const policy = findPolicy(raw.route, raw.tier, this.policies);
      const success = evaluateSuccess(raw, policy);
      const arrival = this.classifyArrival(window2, reportContext.receivedAt);
      const eligible = Boolean(policy) && inWindow && success.outcome !== "unclassified";
      const recordHash = shortHash({
        requestId: raw.requestId,
        eventAt,
        route: raw.route,
        tier: raw.tier,
        status: Number(raw.status),
        latencyMs: Number(raw.latencyMs)
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
        exclusionReason: !policy ? "no_success_policy" : !inWindow ? "event_outside_window" : null,
        outcome: eligible ? success.outcome : "excluded",
        failureReasons: success.failureReasons,
        admitted: arrival.admitted,
        timeliness: arrival.timeliness,
        delayMs: arrival.delayMs,
        recordHash
      };
      return { conflict: false, record, recordHash };
    }
    ingestReport(input = {}) {
      const reportId = input.reportId;
      const receivedAt = input.receivedAt ?? (/* @__PURE__ */ new Date()).toISOString();
      const windowId = input.windowId;
      const incoming = Array.isArray(input.records) ? input.records : [];
      if (!reportId || typeof reportId !== "string") {
        const error = new Error("reportId \u662F\u5FC5\u586B\u7684\u5E42\u7B49\u952E");
        error.code = "REPORT_ID_REQUIRED";
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
          latencyMs: r.latencyMs
        }))
      );
      const existingReport = this.reports.get(reportId);
      if (existingReport) {
        if (existingReport.contentHash !== contentHash) {
          const result2 = {
            status: "conflict",
            code: "IDEMPOTENCY_KEY_PAYLOAD_CONFLICT",
            reportId,
            message: "\u76F8\u540C reportId \u7684\u62A5\u6587\u5185\u5BB9\u4E0D\u4E00\u81F4\uFF1B\u5DF2\u62D2\u7EDD\uFF0C\u672A\u5199\u5165\u4EFB\u4F55\u8BB0\u5F55\u3002"
          };
          this.log("report.conflict", result2, receivedAt);
          return result2;
        }
        const result = {
          status: "duplicate",
          duplicate: true,
          reportId,
          contentHash,
          firstAcceptedAt: existingReport.acceptedAt,
          newRecordCount: 0,
          message: "\u91CD\u590D\u4E0A\u62A5\u5DF2\u88AB\u5E42\u7B49\u5C42\u62E6\u622A\uFF0C\u5206\u5B50\u3001\u5206\u6BCD\u548C\u6570\u636E\u7248\u672C\u5747\u672A\u53D8\u5316\u3002"
        };
        this.log("report.duplicate_blocked", { reportId, contentHash }, receivedAt);
        return result;
      }
      if (incoming.length === 0) {
        const error = new Error("records \u4E0D\u80FD\u4E3A\u7A7A");
        error.code = "RECORDS_REQUIRED";
        throw error;
      }
      const batchIds = /* @__PURE__ */ new Set();
      const prepared = [];
      const duplicateRequestIds = [];
      const conflicts = [];
      for (const raw of incoming) {
        if (!raw.requestId) {
          conflicts.push({ requestId: null, reason: "requestId \u5FC5\u586B" });
          continue;
        }
        if (batchIds.has(raw.requestId)) {
          conflicts.push({ requestId: raw.requestId, reason: "\u540C\u4E00\u6279\u6B21\u5185 requestId \u91CD\u590D\u4E14\u5185\u5BB9\u53EF\u80FD\u51B2\u7A81" });
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
            reason: "requestId \u5DF2\u5B58\u5728\u4F46\u62A5\u6587\u4E0D\u540C\uFF1B\u5982\u9700\u6539\u5224\u8BF7\u8D70\u663E\u5F0F\u66F4\u6B63\u6D41\u7A0B"
          });
          continue;
        }
        prepared.push(preparedItem);
      }
      if (conflicts.length > 0) {
        const result = {
          status: "conflict",
          code: "RECORD_CONFLICT",
          reportId,
          conflicts,
          message: "\u9884\u68C0\u53D1\u73B0\u51B2\u7A81\uFF0C\u6574\u6279\u672A\u5165\u8D26\u3002"
        };
        this.log("report.conflict", { reportId, conflicts }, receivedAt);
        return result;
      }
      const newRecords = prepared.map((p) => p.record);
      const touchedKeys = [...new Set(newRecords.filter((r) => r.eligible).map((r) => budgetKey(r.windowId, r.route, r.tier)))];
      const beforeByKey = /* @__PURE__ */ new Map();
      for (const key of touchedKeys) {
        const { windowId: wId, route, tier } = parseBudgetKey(key);
        beforeByKey.set(key, this.getBudgetView(wId, route, tier, { scope: "live" }));
      }
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
        correctionOnlyCount: 0
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
        const after = this.getBudgetView(wId, route, tier, { scope: "live" });
        if (!this.versionHistory.has(key)) this.versionHistory.set(key, []);
        const versionEntry = {
          revision,
          dataVersion: `r${revision}\xB7${after.sliceHash}`,
          sliceHash: after.sliceHash,
          reportId,
          at: receivedAt,
          numerator: after.numerator,
          denominator: after.denominator,
          consumedRatio: after.consumedRatio,
          level: after.level,
          admittedToSettlement: after.admittedNumerator === after.numerator && after.admittedDenominator === after.denominator
        };
        this.versionHistory.get(key).push(versionEntry);
        revisionEvents.push({ key, before: beforeByKey.get(key), after, versionEntry });
      }
      const correctionOnlyRecords = newRecords.filter((r) => r.eligible && (!r.admitted || this.windows.get(r.windowId)?.status === "settled"));
      receipt.correctionOnlyCount = correctionOnlyRecords.length;
      if (newRecords[0]?.windowId) {
        const window2 = this.windows.get(newRecords[0].windowId);
        receipt.timeliness = this.classifyArrival(window2, receivedAt).timeliness;
      }
      const correctionKeys = [...new Set(correctionOnlyRecords.map((r) => budgetKey(r.windowId, r.route, r.tier)))];
      const correctionIds = [];
      for (const key of correctionKeys) {
        const correction = this.createCorrectionRecord(key, reportId, receivedAt, correctionOnlyRecords);
        correctionIds.push(correction.id);
      }
      for (const change of revisionEvents) {
        const beforeLevel = change.before?.level ?? "no-data";
        const afterLevel = change.after.level;
        if (beforeLevel !== afterLevel || change.versionEntry.revision === 1) {
          const settled = this.windows.get(change.after.windowId)?.status === "settled";
          this.log(
            settled || correctionKeys.includes(change.key) ? "estimate.correction_preview_changed" : "estimate.revised",
            {
              reportId,
              budgetKey: change.key,
              fromLevel: beforeLevel,
              toLevel: afterLevel,
              from: { numerator: change.before?.numerator ?? 0, denominator: change.before?.denominator ?? 0 },
              to: { numerator: change.after.numerator, denominator: change.after.denominator },
              dataVersion: change.versionEntry.dataVersion,
              channel: settled || correctionKeys.includes(change.key) ? "dashboard-correction-only" : "dashboard-live-estimate",
              officialAlertMutated: false
            },
            receivedAt
          );
        }
      }
      this.log(
        "report.accepted",
        {
          reportId,
          contentHash,
          newRecordCount: newRecords.length,
          duplicateRequestCount: duplicateRequestIds.length,
          correctionOnlyCount: correctionOnlyRecords.length,
          touchedKeys,
          correctionIds
        },
        receivedAt
      );
      return {
        status: "accepted",
        duplicate: false,
        reportId,
        contentHash,
        newRecordCount: newRecords.length,
        duplicateRequestIds,
        correctionIds,
        touchedKeys,
        message: `\u5DF2\u5165\u8D26 ${newRecords.length} \u6761\uFF1B\u91CD\u590D requestId ${duplicateRequestIds.length} \u6761\u672A\u91CD\u590D\u8BA1\u7B97\u3002`
      };
    }
    createCorrectionRecord(key, reportId, receivedAt, correctionOnlyRecords) {
      const { windowId, route, tier } = parseBudgetKey(key);
      const window2 = this.getWindow(windowId);
      const live = this.getBudgetView(windowId, route, tier, { scope: "live" });
      const admitted = this.getBudgetView(windowId, route, tier, { scope: "admitted" });
      const official = window2.settlement?.snapshots?.[key] ? clone(window2.settlement.snapshots[key]) : null;
      const baseline = official ?? admitted;
      const id = this.nextId("corr");
      const correction = {
        id,
        key,
        windowId,
        route,
        tier,
        reportId,
        receivedAt,
        createdAt: receivedAt,
        reason: window2.status === "settled" ? "post-settlement-late-data" : "beyond-admission-cutoff",
        status: "recorded",
        recordIds: correctionOnlyRecords.filter((r) => budgetKey(r.windowId, r.route, r.tier) === key).map((r) => r.requestId),
        officialSnapshot: official,
        admittedSnapshot: admitted,
        candidateSnapshot: live,
        diff: {
          numeratorDelta: live.numerator - (baseline?.numerator ?? 0),
          denominatorDelta: live.denominator - (baseline?.denominator ?? 0),
          fromLevel: baseline?.level ?? "no-data",
          toLevel: live.level,
          fromDataVersion: baseline?.dataVersion ?? null,
          toDataVersion: live.dataVersion
        },
        advisoryId: null
      };
      this.corrections.set(id, correction);
      this.correctionOrder.push(id);
      this.log(
        "correction.recorded",
        {
          correctionId: id,
          budgetKey: key,
          reportId,
          reason: correction.reason,
          diff: correction.diff,
          officialAlertMutated: false
        },
        receivedAt
      );
      return correction;
    }
    getBudgetView(windowId, route, tier, options = {}) {
      const scope = options.scope ?? "live";
      const key = budgetKey(windowId, route, tier);
      const window2 = this.getWindow(windowId);
      if ((scope === "official" || scope === "settled") && window2?.settlement?.snapshots?.[key]) {
        return clone(window2.settlement.snapshots[key]);
      }
      const policy = findPolicy(route, tier, this.policies);
      const allMatching = [...this.records.values()].filter(
        (r) => r.windowId === windowId && r.route === route && r.tier === tier
      );
      const included = allMatching.filter((r) => r.eligible).filter((r) => scope !== "admitted" && scope !== "settled" ? true : r.admitted).sort((a, b) => a.requestId.localeCompare(b.requestId));
      const excluded = allMatching.filter((r) => !r.eligible);
      const numerator = included.filter((r) => r.outcome === "error").length;
      const denominator = included.length;
      const successCount = denominator - numerator;
      const target = policy?.target ?? null;
      const allowedErrors = target === null ? null : denominator * (1 - target);
      const remainingBudget = allowedErrors === null ? null : allowedErrors - numerator;
      const consumedRatio = allowedErrors === null || allowedErrors === 0 ? numerator > 0 ? Number.POSITIVE_INFINITY : 0 : numerator / allowedErrors;
      const finiteConsumedRatio = Number.isFinite(consumedRatio) ? consumedRatio : null;
      const revision = this.sliceRevisions.get(key) ?? 0;
      const sliceHash = shortHash(
        included.map((r) => ({
          requestId: r.requestId,
          outcome: r.outcome,
          status: r.status,
          latencyMs: r.latencyMs,
          eventAt: r.eventAt,
          reasons: r.failureReasons
        }))
      );
      const historyForSlice = this.versionHistory.get(key) ?? [];
      const matchingHistoryEntry = [...historyForSlice].reverse().find((entry) => entry.sliceHash === sliceHash);
      const effectiveRevision = matchingHistoryEntry?.revision ?? revision;
      const reasonCounts = {};
      for (const record of included.filter((r) => r.outcome === "error")) {
        for (const reason of record.failureReasons) {
          const reasonKey = reason.replace(/\s*\d+ms?.*$/, "").replace(/HTTP \d+.*/, "HTTP \u72B6\u6001\u7801\u4E0D\u8FBE\u6807");
          reasonCounts[reasonKey] = (reasonCounts[reasonKey] ?? 0) + 1;
        }
      }
      const sourceReports = [...new Set(included.map((r) => r.reportId))].map((reportId) => {
        const report = this.reports.get(reportId);
        return {
          reportId,
          contentHash: report?.contentHash ?? null,
          receivedAt: report?.receivedAt ?? null,
          timeliness: report?.timeliness ?? null
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
        level: "no-data",
        revision: effectiveRevision,
        currentRevision: revision,
        sliceHash,
        dataVersion: `r${effectiveRevision}\xB7${sliceHash}`,
        recordIds: included.map((r) => r.requestId),
        errorRecords: included.filter((r) => r.outcome === "error").map((r) => clone(r)),
        records: included.map((r) => clone(r)),
        excludedRecords: excluded.map((r) => clone(r)),
        reasonCounts,
        sourceReports,
        versionHistory: clone(this.versionHistory.get(key) ?? []),
        admittedNumerator: included.filter((r) => r.admitted && r.outcome === "error").length,
        admittedDenominator: included.filter((r) => r.admitted).length
      };
      view.level = classifyBudgetLevel(view, this.thresholds);
      return view;
    }
    listBudgetKeys() {
      const keys = /* @__PURE__ */ new Set();
      for (const record of this.records.values()) {
        if (record.eligible) keys.add(budgetKey(record.windowId, record.route, record.tier));
      }
      return [...keys].sort();
    }
    getConclusions() {
      return this.listBudgetKeys().map((key) => {
        const { windowId, route, tier } = parseBudgetKey(key);
        const live = this.getBudgetView(windowId, route, tier, { scope: "live" });
        const admitted = this.getBudgetView(windowId, route, tier, { scope: "admitted" });
        const official = this.getBudgetView(windowId, route, tier, { scope: "official" });
        const corrections = this.correctionOrder.map((id) => this.corrections.get(id)).filter((c) => c.key === key);
        return { key, windowId, route, tier, live, admitted, official, corrections };
      });
    }
    settleWindow(windowId, at = (/* @__PURE__ */ new Date()).toISOString(), actor = "scheduled-watermark") {
      const window2 = this.getWindow(windowId);
      if (!window2) {
        const error = new Error(`\u672A\u77E5\u7A97\u53E3\uFF1A${windowId}`);
        error.code = "WINDOW_NOT_FOUND";
        throw error;
      }
      if (window2.settlement) {
        this.log("settle.idempotent_replay", { windowId, settlementId: window2.settlement.id }, at);
        return {
          status: "already-settled",
          duplicate: true,
          settlement: clone(window2.settlement),
          messages: this.messages.filter((m) => m.settlementId === window2.settlement.id)
        };
      }
      const cutoffMs = this.cutoffFor(window2);
      if (Date.parse(at) < cutoffMs) {
        const error = new Error(`\u5C1A\u672A\u5230\u7ED3\u7B97\u65F6\u95F4\uFF1A\u9700\u5728 ${new Date(cutoffMs).toISOString()} \u4E4B\u540E\u7ED3\u7B97`);
        error.code = "SETTLEMENT_NOT_DUE";
        error.details = { cutoffAt: new Date(cutoffMs).toISOString(), requestedAt: at };
        throw error;
      }
      const keys = /* @__PURE__ */ new Set();
      for (const record of this.records.values()) {
        if (record.windowId === windowId && record.eligible && record.admitted) {
          keys.add(budgetKey(record.windowId, record.route, record.tier));
        }
      }
      const snapshots = {};
      const alerts = {};
      const messageIds = [];
      const settlementId = this.nextId("stl");
      for (const key of [...keys].sort()) {
        const { route, tier } = parseBudgetKey(key);
        const view = this.getBudgetView(windowId, route, tier, { scope: "admitted" });
        const frozenView = { ...view, scope: "official-settled", frozenAt: at };
        snapshots[key] = frozenView;
        alerts[key] = {
          key,
          level: view.level,
          rule: `\u9884\u7B97\u6D88\u8017 \u2265 ${this.thresholds.warningConsumedRatio * 100}% \u9884\u8B66\uFF1B\u2265 100% \u544A\u8B66`,
          dataVersion: frozenView.dataVersion,
          numerator: frozenView.numerator,
          denominator: frozenView.denominator,
          settledAt: at
        };
        if (view.level === "warning" || view.level === "critical") {
          const severity = view.level;
          const message = {
            id: this.nextId("msg"),
            kind: "settled-alert",
            channel: "operations",
            severity,
            windowId,
            budgetKey: key,
            settlementId,
            createdAt: at,
            actor,
            official: true,
            supersedes: null,
            title: `${severity === "critical" ? "\u6B63\u5F0F\u4E25\u91CD\u544A\u8B66" : "\u6B63\u5F0F\u9884\u8B66"}\uFF1A${view.policy.method} ${route} \xB7 ${view.policy.tierLabel}`,
            body: `\u7A97\u53E3 ${window2.label} \u5DF2\u6309 ${frozenView.dataVersion} \u7ED3\u7B97\uFF1A\u9519\u8BEF ${view.numerator}/${view.denominator}\uFF0C\u9884\u7B97\u6D88\u8017 ${(view.consumedRatio * 100).toFixed(1)}%\u3002\u8BE5\u7ED3\u8BBA\u5DF2\u51BB\u7ED3\uFF0C\u540E\u7EED\u8FDF\u5230\u6570\u636E\u4E0D\u4F1A\u9759\u9ED8\u6539\u5224\u3002`
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
        algorithmVersion: "error-budget-engine-v1",
        alertRule: alerts[Object.keys(alerts)[0]]?.rule ?? "budget-consumption",
        snapshots,
        alerts,
        messageIds
      };
      window2.status = "settled";
      window2.settlement = settlement;
      this.log(
        "window.settled",
        {
          windowId,
          settlementId,
          snapshotKeys: Object.keys(snapshots),
          messageIds,
          actor
        },
        at
      );
      this.log(
        "operations.alert_published_once",
        { windowId, settlementId, messageIds, note: "\u6BCF\u4E2A\u7ED3\u7B97\u544A\u8B66\u53EA\u751F\u6210\u4E00\u6761\u8FD0\u8425\u6D88\u606F" },
        at
      );
      return { status: "settled", duplicate: false, settlement: clone(settlement), messages: clone(this.messages.filter((m) => messageIds.includes(m.id))) };
    }
    publishCorrectionAdvisory(correctionId, input = {}) {
      const correction = this.corrections.get(correctionId);
      if (!correction) {
        const error = new Error(`\u672A\u77E5\u66F4\u6B63\u8BB0\u5F55\uFF1A${correctionId}`);
        error.code = "CORRECTION_NOT_FOUND";
        throw error;
      }
      const at = input.at ?? (/* @__PURE__ */ new Date()).toISOString();
      const operator = input.operator ?? "ops-oncall";
      const note = input.note ?? "\u503C\u73ED\u540C\u5B66\u663E\u5F0F\u590D\u6838\u8FDF\u5230\u6570\u636E\u540E\u53D1\u5E03\u66F4\u6B63\u901A\u544A\u3002";
      if (correction.status === "advisory-published") {
        return {
          status: "duplicate",
          duplicate: true,
          correction: clone(correction),
          message: clone(this.messages.find((m) => m.id === correction.advisoryMessageId) ?? null)
        };
      }
      const message = {
        id: this.nextId("msg"),
        kind: "correction-advisory",
        channel: "operations",
        severity: correction.candidateSnapshot.level,
        windowId: correction.windowId,
        budgetKey: correction.key,
        correctionId,
        createdAt: at,
        actor: operator,
        official: true,
        explicitCorrection: true,
        supersedesSettlement: false,
        title: `\u4EBA\u5DE5\u66F4\u6B63\u901A\u544A\uFF1A${correction.route} \xB7 ${correction.tier}\uFF08\u4E0D\u8986\u76D6\u539F\u7ED3\u7B97\uFF09`,
        body: `\u8FC7\u665A\u62A5\u544A ${correction.reportId} \u5DF2\u7559\u5728\u66F4\u6B63\u53F0\u8D26\u3002\u82E5\u91C7\u7EB3\u5019\u9009\u7248\u672C ${correction.diff.toDataVersion}\uFF0C\u7ED3\u8BBA\u5C06\u7531 ${correction.diff.fromLevel} \u53D8\u4E3A ${correction.diff.toLevel}\uFF08${correction.diff.numeratorDelta >= 0 ? "+" : ""}${correction.diff.numeratorDelta} \u9519\u8BEF\uFF0C${correction.diff.denominatorDelta >= 0 ? "+" : ""}${correction.diff.denominatorDelta} \u8BF7\u6C42\uFF09\u3002\u6B63\u5F0F\u7ED3\u7B97\u7248\u672C ${correction.diff.fromDataVersion} \u4ECD\u4FDD\u6301\u4E0D\u53D8\uFF1B\u672C\u6D88\u606F\u662F\u65B0\u589E\u901A\u544A\uFF0C\u4E0D\u662F\u9759\u9ED8\u6539\u5224\u3002`,
        note
      };
      this.messages.push(message);
      correction.status = "advisory-published";
      correction.advisoryMessageId = message.id;
      correction.advisory = { at, operator, note, messageId: message.id };
      this.log(
        "correction.advisory_published",
        { correctionId, messageId: message.id, officialAlertMutated: false, settlementSuperseded: false },
        at
      );
      return { status: "published", duplicate: false, correction: clone(correction), message: clone(message) };
    }
    getDashboardModel() {
      return {
        windows: [...this.windows.values()].map((w) => clone(w)),
        policies: clone(this.policies),
        conclusions: this.getConclusions().map((c) => ({
          ...c,
          live: clone(c.live),
          official: c.official ? clone(c.official) : null,
          corrections: clone(c.corrections)
        })),
        reports: this.reportOrder.map((id) => clone(this.reports.get(id))),
        audit: clone(this.audit),
        messages: clone(this.messages),
        corrections: this.correctionOrder.map((id) => clone(this.corrections.get(id))),
        totals: {
          records: this.records.size,
          reports: this.reports.size,
          duplicateReportAttempts: this.audit.filter((e) => e.type === "report.duplicate_blocked").length,
          conflicts: this.audit.filter((e) => e.type === "report.conflict").length,
          corrections: this.correctionOrder.length,
          operationsMessages: this.messages.length
        }
      };
    }
  };

  // src/demo.js
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
    eventOffsetMs
  }) {
    const policy = findPolicy(route, tier, POLICY_MATRIX);
    const safeLatency = Math.max(1, Math.min((policy?.maxLatencyMs ?? 500) - 25, 120));
    const i = String(index).padStart(4, "0");
    return {
      requestId: `${prefix}-${i}`,
      windowId,
      eventAt: isoAt(eventOffsetMs ?? Math.floor(index / Math.max(count, 1) * 285e3) + 5e3),
      route,
      tier,
      status: status ?? 200,
      latencyMs: latencyMs ?? safeLatency
    };
  }
  function makeGroup({ prefix, route, tier, count, errors = {} }) {
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
        eventOffsetMs: override.eventOffsetMs
      });
    });
  }
  function buildInitialReport() {
    const checkoutCritical = makeGroup({
      prefix: "chk-c-v1",
      route: "/checkout",
      tier: "critical",
      count: 40,
      errors: {
        1: { status: 503, latencyMs: 176, eventOffsetMs: 12e3 },
        2: { status: 200, latencyMs: 412, eventOffsetMs: 18e3 }
      }
    });
    const checkoutStandard = makeGroup({
      prefix: "chk-s-v1",
      route: "/checkout",
      tier: "standard",
      count: 120
    });
    const searchCritical = makeGroup({
      prefix: "src-c-v1",
      route: "/search",
      tier: "critical",
      count: 160
    });
    const searchStandard = makeGroup({
      prefix: "src-s-v1",
      route: "/search",
      tier: "standard",
      count: 120
    });
    const reportBatch = makeGroup({
      prefix: "rpt-b-v1",
      route: "/reports/export",
      tier: "batch",
      count: 120,
      errors: {
        7: { status: 500, latencyMs: 4820, eventOffsetMs: 9e4 }
      }
    });
    return {
      reportId: "rep-1000-initial",
      receivedAt: DEMO_TIMES.initialReceivedAt,
      windowId: DEMO_WINDOW.id,
      records: [
        ...checkoutCritical,
        ...checkoutStandard,
        ...searchCritical,
        ...searchStandard,
        ...reportBatch
      ]
    };
  }
  function buildLateRevisionReport() {
    return {
      reportId: "rep-1000-late-successes",
      receivedAt: DEMO_TIMES.revisedReceivedAt,
      windowId: DEMO_WINDOW.id,
      records: makeGroup({
        prefix: "chk-c-v2-late",
        route: "/checkout",
        tier: "critical",
        count: 200
      })
    };
  }
  function buildTooLateReport() {
    return {
      reportId: "rep-1000-too-late-failures",
      receivedAt: DEMO_TIMES.lateReceivedAt,
      windowId: DEMO_WINDOW.id,
      records: makeGroup({
        prefix: "chk-c-v3-corr",
        route: "/checkout",
        tier: "critical",
        count: 10,
        errors: {
          1: { status: 500, latencyMs: 166, eventOffsetMs: 41e3 },
          2: { status: 503, latencyMs: 171, eventOffsetMs: 74e3 },
          3: { status: 500, latencyMs: 188, eventOffsetMs: 132e3 },
          4: { status: 200, latencyMs: 388, eventOffsetMs: 211e3 }
        }
      })
    };
  }
  var DEMO_STEPS = Object.freeze([
    {
      id: "initial",
      label: "\u4E0A\u62A5 v1 \u521D\u59CB\u6279\u6B21",
      description: "40 \u6761\u5173\u952E\u4EA4\u6613\u4E2D 2 \u6761\u5931\u8D25\uFF0C\u5B9E\u65F6\u4F30\u503C\u7ACB\u5373\u663E\u793A\u4E25\u91CD\u544A\u8B66\u3002"
    },
    {
      id: "duplicate",
      label: "\u91CD\u590D\u4E0A\u62A5\u540C\u4E00\u6279\u6B21",
      description: "\u5B8C\u5168\u76F8\u540C\u7684 reportId \u62A5\u6587\u518D\u6B21\u4E0A\u62A5\uFF0C\u5E94\u88AB\u5E42\u7B49\u62E6\u622A\uFF0C\u7248\u672C\u548C\u5206\u5B50\u5206\u6BCD\u4E0D\u53D8\u3002"
    },
    {
      id: "revision",
      label: "\u4E0A\u62A5\u5BBD\u9650\u5185\u8FDF\u5230\u6279\u6B21",
      description: "200 \u6761\u6210\u529F\u8BB0\u5F55\u8865\u5165\u8FC7\u53BB\u7A97\u53E3\uFF0C\u5206\u6BCD\u53D8\u5927\uFF0C\u4E25\u91CD\u544A\u8B66\u964D\u4E3A\u9884\u8B66\u3002"
    },
    {
      id: "settle",
      label: "\u6309\u6C34\u4F4D\u7EBF\u7ED3\u7B97\u7A97\u53E3",
      description: "\u51BB\u7ED3 r2 \u6570\u636E\u5207\u7247\u4E0E\u6B63\u5F0F\u9884\u8B66\uFF0C\u8FD0\u8425\u544A\u8B66\u53EA\u53D1\u5E03\u4E00\u6B21\u3002"
    },
    {
      id: "too-late",
      label: "\u4E0A\u62A5\u8D85\u8FC7\u622A\u6B62\u7EBF\u7684\u6570\u636E",
      description: "\u8FD9\u4E9B\u8BB0\u5F55\u8FDB\u5165\u66F4\u6B63\u53F0\u8D26\u548C\u5B9E\u65F6\u8BD5\u7B97\uFF0C\u4F46\u4E0D\u80FD\u9759\u9ED8\u6539\u5199\u6B63\u5F0F\u7ED3\u8BBA\u3002"
    },
    {
      id: "advisory",
      label: "\u53D1\u5E03\u663E\u5F0F\u4EBA\u5DE5\u66F4\u6B63\u901A\u544A",
      description: "\u65B0\u589E\u4E00\u6761\u8FD0\u8425\u901A\u544A\u8BF4\u660E\u5019\u9009\u6539\u5224\uFF1B\u539F\u7ED3\u7B97\u544A\u8B66\u4FDD\u6301\u4E0D\u53D8\u3002"
    }
  ]);

  // src/app.js
  var $ = (selector) => document.querySelector(selector);
  var engine = new BudgetEngine();
  engine.ingestReport(buildInitialReport());
  var manualCounter = 0;
  var autoRunning = false;
  var openDetails = /* @__PURE__ */ new Set();
  function esc(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  var LEVEL_META = {
    healthy: { label: "\u5065\u5EB7", icon: "\u2713", cls: "good" },
    warning: { label: "\u9884\u8B66", icon: "\u25B2", cls: "warning" },
    serious: { label: "\u4E25\u91CD", icon: "\u25C6", cls: "serious" },
    critical: { label: "\u4E25\u91CD\u544A\u8B66", icon: "\u2715", cls: "critical" },
    "no-data": { label: "\u65E0\u6570\u636E", icon: "\u2013", cls: "neutral" }
  };
  function levelBadge(level, extra = "") {
    const meta = LEVEL_META[level] ?? LEVEL_META["no-data"];
    return `<span class="level-badge ${meta.cls} ${extra}"><span aria-hidden="true">${meta.icon}</span>${esc(meta.label)}</span>`;
  }
  function timeShort(iso) {
    if (!iso) return "\u2014";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "\u2014";
    return date.toISOString().slice(11, 19);
  }
  function numberOrDash(value, digits = 2) {
    if (value === null || value === void 0 || Number.isNaN(value)) return "\u2014";
    const rounded = Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value).toString() : value.toFixed(digits);
    return rounded;
  }
  function signedNumber(value, digits = 2) {
    if (value === null || value === void 0 || Number.isNaN(value)) return "\u2014";
    const normalized = Math.abs(value) < 1e-9 ? 0 : value;
    return `${normalized > 0 ? "+" : ""}${numberOrDash(normalized, digits)}`;
  }
  function timelinessLabel(value) {
    return {
      "on-time": "\u51C6\u65F6",
      "late-within-grace": "\u5BBD\u9650\u5185\u8FDF\u5230",
      "late-beyond-cutoff": "\u8D85\u8FC7\u622A\u6B62\u7EBF"
    }[value] ?? value ?? "\u2014";
  }
  function reasonLabel(reason) {
    if (reason === "\u5EF6\u8FDF") return "\u5EF6\u8FDF\u8D85\u8FC7\u7B56\u7565\u9608\u503C";
    return reason;
  }
  function policyOptionHtml(policy) {
    return `<option value="${esc(policy.route)}||${esc(policy.tier)}">${esc(policy.method)} ${esc(policy.route)} \xB7 ${esc(policy.tierLabel)} \xB7 SLO ${formatPercent(policy.target * 100 ? policy.target : policy.target, 1)}</option>`;
  }
  function budgetBar(view) {
    const ratio = view.consumedRatio ?? (view.numerator > 0 ? 1 : 0);
    const width = Math.max(0, Math.min(100, ratio * 100));
    const valueNow = Math.round(Math.min(100, ratio * 100));
    const valueText = view.consumedRatio === null ? `\u5206\u6BCD ${view.denominator}\uFF0C\u5206\u5B50 ${view.numerator}\uFF0C\u8BE5 SLO \u4E0B\u5141\u8BB8\u9519\u8BEF\u6570\u4E3A 0` : `\u5DF2\u6D88\u8017\u9519\u8BEF\u9884\u7B97 ${formatPercent(view.consumedRatio, 1)}`;
    return `
    <div
      class="budget-bar"
      role="progressbar"
      aria-label="\u9519\u8BEF\u9884\u7B97\u6D88\u8017\u7387"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow="${valueNow}"
      aria-valuetext="${esc(valueText)}"
      title="${esc(valueText)}"
    >
      <div class="fill ${esc(view.level)}" style="width:${width}%"></div>
      <span class="tick warn" title="\u9884\u8B66\u9608\u503C 50%"></span>
      <span class="tick limit" title="\u9884\u7B97\u8017\u5C3D 100%"></span>
    </div>
    <div class="bar-caption">
      <span>0</span>
      <span>\u9884\u8B66 50%</span>
      <span>\u9884\u7B97\u7EBF 100%</span>
      <span><strong>${esc(formatPercent(view.consumedRatio, 1))}</strong></span>
    </div>
  `;
  }
  function versionCard(title, view, kind, footer = "") {
    if (!view) return "";
    return `
    <article class="version-card ${kind}">
      <h4>${esc(title)}</h4>
      <div class="v-row"><span>\u6570\u636E\u7248\u672C</span><strong class="mono">${esc(view.dataVersion)}</strong></div>
      <div class="v-row"><span>\u5206\u5B50 / \u5206\u6BCD</span><strong>${view.numerator} / ${view.denominator}</strong></div>
      <div class="v-row"><span>\u9884\u7B97\u6D88\u8017</span><strong>${esc(formatPercent(view.consumedRatio, 1))}</strong></div>
      <div class="v-row"><span>\u5269\u4F59\u9884\u7B97</span><strong>${esc(numberOrDash(view.remainingBudget))}</strong></div>
      <div class="v-row"><span>\u7ED3\u8BBA</span>${levelBadge(view.level)}</div>
      ${footer}
    </article>
  `;
  }
  function renderWindowStatus(model) {
    const window2 = model.windows[0];
    if (!window2) {
      $("#windowStatus").innerHTML = "";
      return;
    }
    const cutoff = new Date(Date.parse(window2.endAt) + (window2.allowedLatenessMs ?? 12e4)).toISOString();
    const settled = Boolean(window2.settlement);
    const snapshotCount = window2.settlement ? Object.keys(window2.settlement.snapshots).length : 0;
    $("#windowStatus").innerHTML = `
    <div class="window-fact">
      <span>\u544A\u8B66\u7A97\u53E3</span>
      <strong>${esc(window2.label)}</strong>
      <code>${esc(window2.id)}</code>
    </div>
    <div class="window-fact">
      <span>\u6570\u636E\u65F6\u95F4\u8303\u56F4</span>
      <strong>${timeShort(window2.startAt)}\u2013${timeShort(window2.endAt)} UTC</strong>
      <small>\u4E8B\u4EF6\u65F6\u95F4\u843D\u5728\u5DE6\u95ED\u53F3\u5F00\u533A\u95F4\u5185\u624D\u8BA1\u5165\u5206\u6BCD</small>
    </div>
    <div class="window-fact">
      <span>\u8FDF\u5230\u51C6\u5165\u622A\u6B62\u7EBF</span>
      <strong>${timeShort(cutoff)} UTC</strong>
      <small>\u622A\u6B62\u7EBF\u5185\u53EF\u4FEE\u8BA2\u7ED3\u7B97\u7248\u672C\uFF1B\u4E4B\u540E\u4EC5\u4F5C\u66F4\u6B63\u5019\u9009</small>
    </div>
    <div class="window-fact">
      <span>\u7ED3\u7B97\u72B6\u6001</span>
      <strong>${settled ? "\u5DF2\u7ED3\u7B97\u7684\u544A\u8B66\u7A97\u53E3" : "\u672A\u7ED3\u7B97 \xB7 \u4EEA\u8868\u76D8\u5B9E\u65F6\u4F30\u503C"}</strong>
      ${settled ? `<span class="badge badge-settled">${esc(window2.settlement.id)} \xB7 ${snapshotCount} \u4E2A\u51BB\u7ED3\u5207\u7247 \xB7 ${timeShort(window2.settlement.settledAt)} UTC</span>` : '<span class="badge badge-live">\u7B49\u5F85\u6C34\u4F4D\u7EBF 10:07 UTC</span>'}
    </div>
  `;
  }
  function renderStepper(model) {
    const hasReport = (id) => model.reports.some((r) => r.reportId === id);
    const states = {
      initial: hasReport("rep-1000-initial"),
      duplicate: model.audit.some((e) => e.type === "report.duplicate_blocked"),
      revision: hasReport("rep-1000-late-successes"),
      settle: Boolean(model.windows[0]?.settlement),
      "too-late": hasReport("rep-1000-too-late-failures"),
      advisory: model.messages.some((m) => m.kind === "correction-advisory")
    };
    let firstIncompleteFound = false;
    $("#stepper").innerHTML = DEMO_STEPS.map((step, index) => {
      const done = states[step.id];
      let cls = "step";
      if (done) cls += " done";
      else if (!firstIncompleteFound) {
        cls += " current";
        firstIncompleteFound = true;
      }
      return `
      <li class="${cls}" data-testid="step-${esc(step.id)}" data-done="${done}">
        <span class="step-number" aria-hidden="true">${done ? "\u2713" : index + 1}</span>
        <strong>${esc(step.label)}</strong>
        <p>${esc(step.description)}</p>
      </li>
    `;
    }).join("");
    const next = DEMO_STEPS.find((step) => !states[step.id]);
    const primary = $("#primaryStepButton");
    if (autoRunning) {
      primary.disabled = true;
      primary.textContent = "\u81EA\u52A8\u64AD\u653E\u4E2D\u2026";
    } else if (next) {
      primary.disabled = false;
      primary.dataset.step = next.id;
      primary.textContent = `\u4E0B\u4E00\u6B65\uFF1A${next.label}`;
    } else {
      primary.disabled = true;
      primary.textContent = "\u5168\u90E8\u6F14\u793A\u6B65\u9AA4\u5DF2\u5B8C\u6210";
      delete primary.dataset.step;
    }
    $("#autoDemoButton").disabled = autoRunning;
  }
  function renderKpis(model) {
    const settledAlerts = model.messages.filter((m) => m.kind === "settled-alert").length;
    const items = [
      { label: "\u552F\u4E00\u8BF7\u6C42\u8BB0\u5F55", value: model.totals.records, hint: "\u6309 requestId \u53BB\u91CD" },
      { label: "\u5DF2\u63A5\u53D7\u4E0A\u62A5\u6279\u6B21", value: model.totals.reports, hint: "reportId \u5E42\u7B49\u952E" },
      { label: "\u91CD\u590D\u4E0A\u62A5\u62E6\u622A", value: model.totals.duplicateReportAttempts, hint: "\u4E0D\u6539\u53D8\u5206\u5B50\u5206\u6BCD/\u7248\u672C" },
      { label: "\u6B63\u5F0F\u8FD0\u8425\u6D88\u606F", value: model.totals.operationsMessages, hint: `${settledAlerts} \u6761\u7ED3\u7B97\u544A\u8B66\uFF0C\u5176\u4F59\u4E3A\u663E\u5F0F\u901A\u544A` },
      { label: "\u66F4\u6B63\u53F0\u8D26", value: model.totals.corrections, hint: "\u8FC7\u665A\u6570\u636E\u5019\u9009\uFF0C\u4E0D\u9759\u9ED8\u6539\u5224" }
    ];
    $("#kpiGrid").innerHTML = items.map(
      (item) => `
      <article class="kpi">
        <div class="kpi-label">${esc(item.label)}</div>
        <div class="kpi-value">${esc(item.value)}</div>
        <div class="kpi-hint">${esc(item.hint)}</div>
      </article>
    `
    ).join("");
  }
  function renderGuard(model) {
    const settledWindow = model.windows.find((w) => w.settlement);
    const drifted = model.conclusions.filter(
      (c) => c.official && c.live.dataVersion !== c.official.dataVersion
    );
    if (!model.conclusions.length) {
      $("#consistencyGuard").innerHTML = `
      <div class="guard ok" data-testid="empty-guard">
        <div class="guard-icon" aria-hidden="true">i</div>
        <div><h2>\u7B49\u5F85\u4E0A\u62A5\u6570\u636E</h2><p>\u5148\u6267\u884C\u7B2C\u4E00\u6B65\u8F7D\u5165\u6F14\u793A\uFF0C\u6216\u5728\u53F3\u4FA7\u624B\u52A8\u4E0A\u62A5\u4E00\u6761\u8BF7\u6C42\u8BB0\u5F55\u3002</p></div>
      </div>`;
      return;
    }
    if (drifted.length) {
      const text = drifted.map((c) => {
        const p = c.live.policy;
        return `${p.method} ${c.route} \xB7 ${p.tierLabel}\uFF1A\u6B63\u5F0F ${c.official.level}\uFF08${c.official.dataVersion}\uFF09 / \u5B9E\u65F6\u5019\u9009 ${c.live.level}\uFF08${c.live.dataVersion}\uFF09`;
      }).join("\uFF1B");
      $("#consistencyGuard").innerHTML = `
      <div class="guard" data-testid="drift-guard">
        <div class="guard-icon" aria-hidden="true">!</div>
        <div>
          <h2>\u5B9E\u65F6\u4F30\u503C\u5DF2\u56E0\u8FC7\u665A\u6570\u636E\u53D8\u5316\uFF0C\u4F46\u5DF2\u7ED3\u7B97\u544A\u8B66\u6CA1\u6709\u88AB\u8986\u76D6</h2>
          <p>${esc(text)}\u3002\u5DEE\u5F02\u53EA\u8FDB\u5165\u66F4\u6B63\u53F0\u8D26\uFF1B\u8FD0\u8425\u7AEF\u4E0D\u4F1A\u6536\u5230\u81EA\u52A8\u7684\u77DB\u76FE\u6539\u5224\uFF0C\u53EA\u80FD\u7531\u503C\u73ED\u540C\u5B66\u663E\u5F0F\u53D1\u5E03\u66F4\u6B63\u901A\u544A\u3002</p>
        </div>
      </div>`;
      return;
    }
    if (settledWindow) {
      $("#consistencyGuard").innerHTML = `
      <div class="guard ok" data-testid="settled-guard">
        <div class="guard-icon" aria-hidden="true">\u2713</div>
        <div>
          <h2>\u7A97\u53E3\u5DF2\u7ED3\u7B97\uFF0C\u6B63\u5F0F\u7ED3\u8BBA\u5DF2\u51BB\u7ED3</h2>
          <p>\u7ED3\u7B97\u5FEB\u7167\u3001\u5206\u5B50\u5206\u6BCD\u3001\u6570\u636E\u7248\u672C\u548C\u544A\u8B66\u6D88\u606F\u5747\u4FDD\u6301\u4E0D\u53D8\uFF1B\u540E\u7EED\u8FDF\u5230\u6570\u636E\u4F1A\u5355\u72EC\u5F62\u6210\u66F4\u6B63\u8BB0\u5F55\u3002</p>
        </div>
      </div>`;
      return;
    }
    $("#consistencyGuard").innerHTML = `
    <div class="guard ok" data-testid="live-guard">
      <div class="guard-icon" aria-hidden="true">\u25D4</div>
      <div>
        <h2>\u5F53\u524D\u663E\u793A\u7684\u662F\u4EEA\u8868\u76D8\u5B9E\u65F6\u4F30\u503C</h2>
        <p>\u7A97\u53E3\u5C1A\u672A\u5230\u6C34\u4F4D\u7EBF/\u672A\u7ED3\u7B97\uFF1B\u5BBD\u9650\u5185\u8FDF\u5230\u8BB0\u5F55\u4F1A\u521B\u5EFA\u65B0\u7248\u672C\u5E76\u5141\u8BB8\u4F30\u503C\u548C\u9884\u4F30\u544A\u8B66\u53D8\u5316\u3002\u7ED3\u7B97\u540E\u624D\u4EA7\u751F\u4E0D\u53EF\u9759\u9ED8\u64A4\u56DE\u7684\u8FD0\u8425\u544A\u8B66\u3002</p>
      </div>
    </div>`;
  }
  function renderBudgetCard(c) {
    const live = c.live;
    const official = c.official;
    const admitted = c.admitted;
    const primary = official ?? live;
    const hasPostCutoffBeforeSettlement = !official && admitted.dataVersion !== live.dataVersion;
    const secondary = official && official.dataVersion !== live.dataVersion ? live : hasPostCutoffBeforeSettlement ? admitted : null;
    const secondaryIsCandidate = Boolean(official);
    const policy = live.policy;
    const detailKey = `budget:${c.key}`;
    const isOpen = openDetails.has(detailKey);
    const reasonEntries = Object.entries(primary.reasonCounts ?? {});
    const errorRows = primary.errorRecords.map(
      (r) => `
      <tr>
        <td class="mono">${esc(r.requestId)}</td>
        <td class="mono">${timeShort(r.eventAt)}</td>
        <td>${esc(r.status)}</td>
        <td class="num">${esc(r.latencyMs)}ms</td>
        <td>${esc(r.failureReasons.join("\uFF1B"))}</td>
      </tr>`
    ).join("");
    const reportRows = primary.sourceReports.map(
      (r) => `
      <tr>
        <td class="mono">${esc(r.reportId)}</td>
        <td class="mono">${esc(r.contentHash)}</td>
        <td>${timeShort(r.receivedAt)}</td>
        <td>${esc(timelinessLabel(r.timeliness))}</td>
      </tr>`
    ).join("");
    const historyRows = live.versionHistory.map(
      (v) => `
      <tr>
        <td><strong class="mono">${esc(v.dataVersion)}</strong></td>
        <td>${timeShort(v.at)}</td>
        <td class="num">${v.numerator}</td>
        <td class="num">${v.denominator}</td>
        <td class="num">${esc(formatPercent(v.consumedRatio, 1))}</td>
        <td>${levelBadge(v.level)}</td>
      </tr>`
    ).join("");
    const idList = primary.recordIds.map((id) => `<code>${esc(id)}</code>`).join(" ");
    const secondaryIdList = secondary ? secondary.recordIds.map((id) => `<code>${esc(id)}</code>`).join(" ") : "";
    const excludedRows = primary.excludedRecords.map(
      (r) => `<li class="mono">${esc(r.requestId)} \u2014 ${esc(r.exclusionReason ?? "excluded")}</li>`
    ).join("");
    return `
    <details
      class="budget-card ${primary.level === "critical" ? "attention" : ""}"
      data-detail-key="${esc(detailKey)}"
      data-testid="budget-conclusion"
      data-budget-key="${esc(c.key)}"
      data-scope="${official ? "official-settled" : "live"}"
      data-level="${esc(primary.level)}"
      data-numerator="${primary.numerator}"
      data-denominator="${primary.denominator}"
      data-data-version="${esc(primary.dataVersion)}"
      ${official ? `data-official-version="${esc(official.dataVersion)}" data-official-level="${esc(official.level)}"` : ""}
      ${secondary ? `data-secondary-version="${esc(secondary.dataVersion)}" data-secondary-level="${esc(secondary.level)}"` : ""}
      ${isOpen ? "open" : ""}
    >
      <summary class="budget-summary" data-testid="budget-expand">
        <div class="route-title-wrap">
          <div class="route-title">
            <span class="method">${esc(policy.method)}</span>
            <span class="route-path">${esc(policy.route)}</span>
            <span class="tier-tag">${esc(policy.tierLabel)} \xB7 ${esc(policy.tier)}</span>
          </div>
          <div class="budget-subline">${esc(live.windowId)} \xB7 SLO ${formatPercent(policy.target, 1)} \xB7 ${esc(policy.rationale)}</div>
        </div>

        <div class="primary-metric">
          <div class="metric-line">
            <span class="fraction"><span class="numerator">${primary.numerator}</span> / <span class="denominator">${primary.denominator}</span></span>
            <span>${levelBadge(primary.level)}</span>
            <span class="data-version">${esc(primary.dataVersion)}</span>
          </div>
          ${budgetBar(primary)}
          ${secondary ? `<div class="secondary-estimate" data-testid="secondary-estimate">
                   <span class="badge ${secondaryIsCandidate ? "badge-live" : "badge-settled"}">${secondaryIsCandidate ? "\u5B9E\u65F6\u5168\u91CF" : "\u622A\u6B62\u7EBF\u5185\u51C6\u5165\u53E3\u5F84"} ${esc(secondary.dataVersion)}</span>
                   <span>${secondary.numerator}/${secondary.denominator} \xB7 ${esc(formatPercent(secondary.consumedRatio, 1))}</span>
                   ${levelBadge(secondary.level)}
                   <span class="secondary-note">${secondaryIsCandidate ? "\u4E0D\u8986\u76D6\u5DE6\u4FA7\u6B63\u5F0F\u7ED3\u8BBA" : "\u7ED3\u7B97\u65F6\u5C06\u51BB\u7ED3\u6B64\u53E3\u5F84\uFF1B\u5168\u91CF\u5B9E\u65F6\u503C\u89C1\u8BE6\u60C5"}</span>
                 </div>` : `<div class="secondary-estimate"><span class="badge badge-live">${official ? "\u4E0E\u7ED3\u7B97\u5FEB\u7167\u4E00\u81F4" : "\u672A\u7ED3\u7B97 \xB7 \u5B9E\u65F6\u4F30\u503C\u53EF\u4FEE\u8BA2"}</span></div>`}
        </div>

        <div class="summary-side">
          ${official ? '<span class="badge badge-settled">\u5DF2\u7ED3\u7B97\u6B63\u5F0F\u53E3\u5F84</span>' : '<span class="badge badge-live">\u4EEA\u8868\u76D8\u5B9E\u65F6\u4F30\u503C</span>'}
          <span class="expand-hint">\u5C55\u5F00\u5206\u5B50 / \u5206\u6BCD / \u7248\u672C \u25BE</span>
        </div>
      </summary>

      <div class="budget-details">
        <div class="version-strip">
          ${official ? versionCard("\u6B63\u5F0F\u7ED3\u7B97\u5FEB\u7167\uFF08\u4E0D\u53EF\u53D8\uFF09", official, "official", `<div class="v-row"><span>\u7ED3\u7B97\u65F6\u95F4</span><strong>${timeShort(official.frozenAt)}</strong></div>`) : versionCard("\u4EEA\u8868\u76D8\u5B9E\u65F6\u5168\u91CF\uFF08\u672A\u7ED3\u7B97\uFF09", live, "live")}
          ${official && secondaryIsCandidate && secondary ? versionCard("\u4EEA\u8868\u76D8\u5B9E\u65F6\u5168\u91CF\uFF08\u4EC5\u89C2\u6D4B/\u66F4\u6B63\u5019\u9009\uFF09", secondary, "candidate") : ""}
          ${!official && hasPostCutoffBeforeSettlement ? versionCard("\u622A\u6B62\u7EBF\u5185\u51C6\u5165\u53E3\u5F84\uFF08\u7ED3\u7B97\u5C06\u51BB\u7ED3\uFF09", admitted, "official") : ""}
        </div>

        <dl class="detail-grid">
          <div class="stat-box"><dt>\u5206\u5B50\uFF1A\u5931\u8D25\u8BF7\u6C42</dt><dd data-testid="numerator">${primary.numerator}</dd></div>
          <div class="stat-box"><dt>\u5206\u6BCD\uFF1A\u5408\u683C\u8BF7\u6C42</dt><dd data-testid="denominator">${primary.denominator}</dd></div>
          <div class="stat-box"><dt>\u6210\u529F\u8BF7\u6C42</dt><dd>${primary.successCount}</dd></div>
          <div class="stat-box"><dt>SLO \u76EE\u6807</dt><dd>${formatPercent(primary.target, 2)}</dd></div>
          <div class="stat-box"><dt>\u5141\u8BB8\u9519\u8BEF\u9884\u7B97</dt><dd>${numberOrDash(primary.allowedErrors)} \u7B14</dd></div>
          <div class="stat-box"><dt>\u5269\u4F59\u9884\u7B97</dt><dd class="${primary.remainingBudget < 0 ? "neg" : "pos"}">${signedNumber(primary.remainingBudget)} \u7B14</dd></div>
        </dl>

        <div class="formula" data-testid="budget-formula">
          \u6D88\u8017\u7387 = \u5206\u5B50 \xF7 [\u5206\u6BCD \xD7\uFF081 \u2212 SLO\uFF09] =
          <strong>${primary.numerator}</strong> \xF7
          [<strong>${primary.denominator}</strong> \xD7 ${(1 - primary.target).toFixed(4)}]
          = <strong>${esc(formatPercent(primary.consumedRatio, 2))}</strong>
          \uFF1B\u6570\u636E\u7248\u672C <strong class="mono">${esc(primary.dataVersion)}</strong>
        </div>

        <div class="detail-columns">
          <section class="detail-block">
            <h4>\u6210\u529F\u6807\u51C6\u4E0E\u5206\u5B50\u6784\u6210</h4>
            <ul class="criteria-list">
              ${policy.criteria.map((item) => `<li>${esc(item)}</li>`).join("")}
            </ul>
            ${reasonEntries.length ? `<div class="tags">${reasonEntries.map(([reason, count]) => `<span class="badge critical">${esc(reasonLabel(reason))} \xD7 ${count}</span>`).join("")}</div>` : '<p class="muted-note">\u5F53\u524D\u5206\u5B50\u4E3A 0\uFF0C\u6CA1\u6709\u5931\u8D25\u539F\u56E0\u3002</p>'}
            ${errorRows ? `<div class="table-wrap scroll-list"><table class="data-table">
                    <thead><tr><th>requestId</th><th>\u4E8B\u4EF6</th><th>\u72B6\u6001</th><th>\u5EF6\u8FDF</th><th>\u5931\u8D25\u539F\u56E0</th></tr></thead>
                    <tbody>${errorRows}</tbody>
                  </table></div>` : ""}
          </section>

          <section class="detail-block">
            <h4>\u5206\u6BCD\u6765\u6E90\u4E0E\u6570\u636E\u7248\u672C</h4>
            <p class="muted-note">\u4E0B\u8868\u53EA\u5217\u51FA\u751F\u6210\u5F53\u524D\u5C55\u5F00\u7ED3\u8BBA <span class="mono">${esc(primary.dataVersion)}</span> \u65F6\u5B9E\u9645\u91C7\u7528\u7684 reportId\uFF1B\u91CD\u590D\u4E0A\u62A5\u548C\u672A\u91C7\u7EB3\u7684\u8FC7\u665A\u6279\u6B21\u4E0D\u4F1A\u6DF7\u5165\u6B63\u5F0F\u5206\u6BCD\u3002</p>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>\u6765\u6E90 reportId</th><th>\u6279\u6B21\u54C8\u5E0C</th><th>\u63A5\u6536</th><th>\u8FDF\u5230\u5206\u7C7B</th></tr></thead>
                <tbody>${reportRows}</tbody>
              </table>
            </div>
            <h4>\u7248\u672C\u5386\u53F2\uFF08\u5F53\u524D\u8D26\u672C\u53EF\u89C1\uFF0C\u542B\u672A\u91C7\u7EB3\u5019\u9009\uFF09</h4>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>\u6570\u636E\u7248\u672C</th><th>\u65F6\u95F4</th><th>\u5206\u5B50</th><th>\u5206\u6BCD</th><th>\u6D88\u8017</th><th>\u7ED3\u8BBA</th></tr></thead>
                <tbody>${historyRows}</tbody>
              </table>
            </div>
          </section>
        </div>

        <details class="raw-details">
          <summary>
            \u67E5\u770B\u672C\u7ED3\u8BBA\uFF08${official ? "\u6B63\u5F0F\u7ED3\u7B97\u53E3\u5F84" : "\u5B9E\u65F6\u53E3\u5F84"} ${esc(primary.dataVersion)}\uFF09\u4F7F\u7528\u7684
            ${primary.recordIds.length} \u4E2A requestId \u4E0E\u6392\u9664\u8BB0\u5F55
          </summary>
          <p class="id-list mono">${idList || "\uFF08\u65E0\uFF09"}</p>
          ${excludedRows ? `<h4>\u5DF2\u6392\u9664\uFF08${primary.excludedRecords.length}\uFF09</h4><ul class="simple-list">${excludedRows}</ul>` : ""}
        </details>
        ${secondary ? `<details class="raw-details secondary-id-details">
                <summary>
                  \u67E5\u770B${secondaryIsCandidate ? "\u5B9E\u65F6\u5168\u91CF\u5019\u9009" : "\u622A\u6B62\u7EBF\u5185\u51C6\u5165\u53E3\u5F84"}
                  \uFF08${esc(secondary.dataVersion)}\uFF09\u4F7F\u7528\u7684 ${secondary.recordIds.length} \u4E2A requestId
                </summary>
                <p class="id-list mono">${secondaryIdList || "\uFF08\u65E0\uFF09"}</p>
              </details>` : ""}
      </div>
    </details>
  `;
  }
  function renderBudgetList(model) {
    if (!model.conclusions.length) {
      $("#budgetList").innerHTML = `
      <div class="empty-state" data-testid="budget-empty">
        \u8FD8\u6CA1\u6709\u4EFB\u4F55\u5408\u683C\u8BF7\u6C42\u3002\u70B9\u51FB\u201C\u4E0B\u4E00\u6B65\uFF1A\u4E0A\u62A5 v1 \u521D\u59CB\u6279\u6B21\u201D\u5F00\u59CB\u3002
      </div>`;
      return;
    }
    const severityRank = { critical: 4, serious: 3, warning: 2, healthy: 1, "no-data": 0 };
    const sorted = [...model.conclusions].sort((a, b) => {
      const primaryA = a.official ?? a.live;
      const primaryB = b.official ?? b.live;
      return severityRank[primaryB.level] - severityRank[primaryA.level] || a.key.localeCompare(b.key);
    });
    $("#budgetList").innerHTML = sorted.map(renderBudgetCard).join("");
  }
  function versionDisposition(entry, conclusion) {
    if (conclusion.official?.dataVersion === entry.dataVersion) {
      return { label: "\u5DF2\u7ED3\u7B97\u51BB\u7ED3", cls: "settled" };
    }
    if (conclusion.official && entry.revision > conclusion.official.revision) {
      return { label: "\u66F4\u6B63\u5019\u9009 \xB7 \u672A\u91C7\u7EB3", cls: "candidate" };
    }
    if (entry === conclusion.live.versionHistory.at(-1) && !conclusion.official) {
      return { label: "\u5F53\u524D\u5B9E\u65F6\u4F30\u503C", cls: "live" };
    }
    return { label: "\u5DF2\u88AB\u65B0\u7248\u672C\u66FF\u4EE3", cls: "neutral" };
  }
  function renderRevisionCompare(model) {
    const focus = model.conclusions.find((c) => c.route === "/checkout" && c.tier === "critical") ?? model.conclusions.find((c) => c.live.versionHistory.length > 1);
    if (!focus) {
      $("#revisionCompare").innerHTML = `
      <div class="revision-scroll"><div class="empty-state">\u6682\u65E0\u7248\u672C\u3002\u4E0A\u62A5\u521D\u59CB\u6279\u6B21\u540E\uFF0C\u8FD9\u91CC\u4F1A\u5C55\u793A r1\uFF1B\u5BBD\u9650\u5185\u8FDF\u5230\u6279\u6B21\u5C06\u6F14\u793A\u544A\u8B66\u5982\u4F55\u964D\u7EA7\u3002</div></div>`;
      return;
    }
    const entries = focus.live.versionHistory;
    const cards = entries.map((entry) => {
      const disposition = versionDisposition(entry, focus);
      return `
        <article class="flow-card" data-testid="revision-card" data-version="${esc(entry.dataVersion)}">
          <div class="flow-head">
            <span class="flow-title mono">${esc(entry.dataVersion)}</span>
            ${levelBadge(entry.level)}
          </div>
          <div class="flow-meta">${timeShort(entry.at)} \xB7 <span class="mono">${esc(entry.reportId)}</span></div>
          <p class="flow-numbers"><strong>${entry.numerator}</strong> \u9519\u8BEF / <strong>${entry.denominator}</strong> \u8BF7\u6C42 \xB7 \u6D88\u8017 <strong>${esc(formatPercent(entry.consumedRatio, 1))}</strong></p>
          <span class="badge badge-${disposition.cls === "neutral" ? "neutral" : disposition.cls === "live" ? "live" : disposition.cls === "settled" ? "settled" : "correction"}">${esc(disposition.label)}</span>
        </article>
      `;
    }).join("");
    const transitions = entries.slice(1).map((entry, index) => {
      const before = entries[index];
      return `
      <div class="transition-line" data-testid="revision-transition">
        <span class="mono">${esc(before.dataVersion)}</span>
        ${levelBadge(before.level)}
        <span class="mini-arrow" aria-hidden="true">\u2192</span>
        <span class="mono">${esc(entry.dataVersion)}</span>
        ${levelBadge(entry.level)}
        <span class="transition-text">${focus.official && entry.revision > focus.official.revision ? "\u53EA\u6539\u53D8\u5B9E\u65F6\u8BD5\u7B97/\u66F4\u6B63\u5019\u9009\uFF0C\u6B63\u5F0F\u544A\u8B66\u4E0D\u53D8" : focus.official?.dataVersion === entry.dataVersion ? "\u6210\u4E3A\u5DF2\u7ED3\u7B97\u6B63\u5F0F\u7ED3\u8BBA" : "\u7ED3\u7B97\u524D\u7684\u4EEA\u8868\u76D8\u9884\u4F30\u544A\u8B66\u968F\u4E4B\u4FEE\u8BA2"}</span>
      </div>`;
    });
    $("#revisionCompare").innerHTML = `
    <div class="revision-scroll">
      <div class="version-flow">${cards}</div>
      <div class="transition-list">${transitions.join("") || '<p class="muted-note">\u7B49\u5F85\u7B2C\u4E8C\u4E2A\u6570\u636E\u7248\u672C\u3002</p>'}</div>
    </div>
  `;
  }
  function renderOpsFeed(model) {
    if (!model.messages.length) {
      $("#opsFeed").innerHTML = `
      <div class="empty-state" data-testid="ops-empty">
        \u5C1A\u65E0\u8FD0\u8425\u7AEF\u6D88\u606F\u3002<br />\u672A\u7ED3\u7B97\u524D\uFF0C\u4EEA\u8868\u76D8\u7684\u5B9E\u65F6\u4F30\u503C\u548C\u9884\u4F30\u544A\u8B66\u53D8\u5316\u4E0D\u4F1A\u901A\u77E5\u8FD0\u8425\uFF1B\u7ED3\u7B97\u65F6\u6BCF\u4E2A\u6B63\u5F0F\u544A\u8B66\u53EA\u53D1\u5E03\u4E00\u6B21\u3002
      </div>`;
      return;
    }
    $("#opsFeed").innerHTML = model.messages.map((m) => {
      const severity = m.severity ?? "neutral";
      const kindLabel = m.kind === "settled-alert" ? "\u5DF2\u7ED3\u7B97\u544A\u8B66 \xB7 \u6B63\u5F0F\u4E14\u4E0D\u53EF\u9759\u9ED8\u6539\u5224" : "\u4EBA\u5DE5\u66F4\u6B63\u901A\u544A \xB7 \u65B0\u589E\u6D88\u606F\uFF0C\u4E0D\u8986\u76D6\u539F\u7ED3\u8BBA";
      return `
        <article class="message-card severity-${esc(severity)} kind-${esc(m.kind)}" data-testid="ops-message" data-message-id="${esc(m.id)}">
          <div class="message-head">
            <h3>${esc(m.title)}</h3>
            <time class="message-time" datetime="${esc(m.createdAt)}" title="${esc(m.createdAt)}">${timeShort(m.createdAt)} UTC</time>
          </div>
          <p>${esc(m.body)}</p>
          <div class="message-tags">
            <span class="badge ${esc(severity)}">${esc(LEVEL_META[severity]?.label ?? severity)}</span>
            <span class="badge ${m.kind === "settled-alert" ? "badge-settled" : "badge-correction"}">${esc(kindLabel)}</span>
            <span class="badge neutral mono">${esc(m.id)}</span>
          </div>
        </article>`;
    }).join("");
  }
  function renderCorrections(model) {
    if (!model.corrections.length) {
      $("#correctionList").innerHTML = `
      <div class="empty-state" data-testid="correction-empty">
        \u8D85\u8FC7\u51C6\u5165\u622A\u6B62\u7EBF\u6216\u5728\u7ED3\u7B97\u540E\u5230\u8FBE\u7684\u6570\u636E\u4F1A\u4FDD\u7559\u5728\u8FD9\u91CC\u3002\u7CFB\u7EDF\u53EF\u4EE5\u8BA1\u7B97\u201C\u82E5\u7EB3\u5165\u4F1A\u600E\u6837\u201D\uFF0C\u4F46\u4E0D\u4F1A\u9759\u9ED8\u66FF\u6362\u6B63\u5F0F\u7ED3\u8BBA\u3002
      </div>`;
      return;
    }
    $("#correctionList").innerHTML = model.corrections.map((c) => {
      const published = c.status === "advisory-published";
      return `
        <article class="correction-card status-${esc(c.status)}" data-testid="correction-item" data-correction-id="${esc(c.id)}">
          <div class="correction-head">
            <h3>${esc(c.route)} \xB7 ${esc(c.tier)} <span class="mono">${esc(c.id)}</span></h3>
            <time class="correction-time" datetime="${esc(c.receivedAt)}">${timeShort(c.receivedAt)} UTC</time>
          </div>
          <p>
            \u62A5\u544A <code>${esc(c.reportId)}</code>\uFF1B\u539F\u56E0\uFF1A${esc(
        c.reason === "post-settlement-late-data" ? "\u7ED3\u7B97\u540E\u8FDF\u5230" : "\u8D85\u8FC7\u51C6\u5165\u622A\u6B62\u7EBF"
      )}\uFF1B\u5305\u542B ${c.recordIds.length} \u6761\u8FC7\u665A\u8BB0\u5F55\u3002
          </p>
          <div class="diff-line">
            <span class="mono">${esc(c.diff.fromDataVersion ?? "\u65E0\u6B63\u5F0F\u57FA\u7EBF")}</span>
            ${levelBadge(c.diff.fromLevel)}
            <span class="mini-arrow" aria-hidden="true">\u2192</span>
            <span class="mono">${esc(c.diff.toDataVersion)}</span>
            ${levelBadge(c.diff.toLevel)}
          </div>
          <p>\u5206\u5B50\u53D8\u5316 <strong>${signedNumber(c.diff.numeratorDelta, 0)}</strong>\uFF0C\u5206\u6BCD\u53D8\u5316 <strong>${signedNumber(c.diff.denominatorDelta, 0)}</strong>\u3002</p>
          <div class="correction-tags">
            <span class="badge ${published ? "good" : "warning"}">${published ? "\u66F4\u6B63\u901A\u544A\u5DF2\u53D1\u5E03" : "\u5F85\u4EBA\u5DE5\u590D\u6838"}</span>
            <span class="badge neutral">\u6B63\u5F0F\u544A\u8B66\u672A\u88AB\u4FEE\u6539</span>
            ${published ? `<span class="badge badge-settled mono">${esc(c.advisoryMessageId)}</span>` : `<button class="btn btn-primary" type="button" data-action="publish-advisory" data-id="${esc(c.id)}" data-testid="publish-advisory-${esc(c.id)}">\u53D1\u5E03\u663E\u5F0F\u66F4\u6B63\u901A\u544A</button>`}
          </div>
          ${published && c.advisory ? `<p class="advisory-note">${esc(c.advisory.operator)} \u4E8E ${timeShort(c.advisory.at)} \u53D1\u5E03\uFF1A${esc(c.advisory.note)}</p>` : ""}
        </article>`;
    }).join("");
  }
  function renderAudit(model) {
    if (!model.reports.length) {
      $("#reportTable").innerHTML = '<div class="empty-state">\u6682\u65E0\u4E0A\u62A5\u6279\u6B21\u3002</div>';
    } else {
      $("#reportTable").innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>reportId</th><th>\u5185\u5BB9\u54C8\u5E0C</th><th>\u9996\u6B21\u63A5\u6536</th><th class="num">\u65B0\u8BB0\u5F55</th><th>\u91CD\u590D requestId</th><th>\u5230\u8FBE\u5206\u7C7B</th></tr></thead>
          <tbody>
            ${model.reports.map(
        (r) => `
              <tr>
                <td class="mono">${esc(r.reportId)}</td>
                <td class="mono">${esc(r.contentHash)}</td>
                <td>${timeShort(r.receivedAt)} UTC</td>
                <td class="num">${r.newRecordCount}</td>
                <td>${r.duplicateRequestIds?.length ? esc(r.duplicateRequestIds.join(", ")) : "\u2014"}</td>
                <td>${esc(timelinessLabel(r.timeliness))}</td>
              </tr>`
      ).join("")}
          </tbody>
        </table>
      </div>`;
    }
    const eventLabels = {
      "report.accepted": "\u4E0A\u62A5\u5DF2\u5165\u8D26",
      "report.duplicate_blocked": "\u91CD\u590D\u4E0A\u62A5\u5DF2\u62E6\u622A",
      "report.conflict": "\u4E0A\u62A5\u51B2\u7A81\uFF0C\u6574\u6279\u62D2\u7EDD",
      "estimate.revised": "\u5B9E\u65F6\u4F30\u503C\u5DF2\u4FEE\u8BA2",
      "estimate.correction_preview_changed": "\u66F4\u6B63\u5019\u9009\u8BD5\u7B97\u53D8\u5316",
      "window.settled": "\u7A97\u53E3\u5DF2\u7ED3\u7B97\u5E76\u51BB\u7ED3\u5FEB\u7167",
      "settle.idempotent_replay": "\u91CD\u590D\u7ED3\u7B97\u8BF7\u6C42\u88AB\u5FFD\u7565",
      "operations.alert_published_once": "\u8FD0\u8425\u544A\u8B66\u5DF2\u53D1\u5E03\uFF08\u4EC5\u4E00\u6B21\uFF09",
      "correction.recorded": "\u5DF2\u5EFA\u7ACB\u66F4\u6B63\u8BB0\u5F55",
      "correction.advisory_published": "\u4EBA\u5DE5\u66F4\u6B63\u901A\u544A\u5DF2\u53D1\u5E03"
    };
    $("#auditTimeline").innerHTML = model.audit.slice().reverse().map((event) => {
      const cls = event.type.includes("duplicate") || event.type.includes("conflict") ? "duplicate" : event.type.includes("settled") ? "settled" : event.type.includes("correction") ? "correction" : "";
      let summary = "";
      if (event.reportId) summary += `\u62A5\u544A ${event.reportId} `;
      if (event.budgetKey) summary += `\u9884\u7B97 ${event.budgetKey.split("||").slice(1).join(" \xB7 ")} `;
      if (event.fromLevel && event.toLevel) summary += `${event.fromLevel} \u2192 ${event.toLevel}`;
      if (event.messageIds?.length) summary += `\u6D88\u606F ${event.messageIds.join(", ")}`;
      return `
        <article class="audit-event ${cls}" data-testid="audit-event" data-event-type="${esc(event.type)}">
          <div class="audit-event-time">${timeShort(event.at)} UTC \xB7 ${esc(event.id)}</div>
          <strong>${esc(eventLabels[event.type] ?? event.type)}</strong>
          ${summary ? `<p>${esc(summary)}</p>` : ""}
          <details class="raw-details">
            <summary>\u539F\u59CB\u4E8B\u4EF6</summary>
            <pre class="json">${esc(JSON.stringify(event, null, 2))}</pre>
          </details>
        </article>`;
    }).join("");
  }
  function renderPolicyMatrix() {
    $("#policyMatrix").innerHTML = `
    <div class="table-wrap">
      <table class="data-table" data-testid="policy-table">
        <thead>
          <tr><th>\u8DEF\u7531</th><th>\u8BF7\u6C42\u7B49\u7EA7</th><th>SLO</th><th>\u6210\u529F\u6807\u51C6</th><th>\u4E3A\u4EC0\u4E48\u8FD9\u6837\u533A\u5206</th></tr>
        </thead>
        <tbody>
          ${POLICY_MATRIX.map(
      (p) => `
            <tr>
              <td><span class="method">${esc(p.method)}</span> <code>${esc(p.route)}</code></td>
              <td><span class="tier-tag">${esc(p.tierLabel)}</span> <code>${esc(p.tier)}</code></td>
              <td><strong>${formatPercent(p.target, 1)}</strong></td>
              <td>${p.criteria.map((x) => esc(x)).join("<br />")}</td>
              <td>${esc(p.rationale)}</td>
            </tr>`
    ).join("")}
        </tbody>
      </table>
    </div>`;
  }
  function renderCalculator() {
    const select = $("#calcPolicy");
    if (!select.options.length) {
      select.innerHTML = POLICY_MATRIX.map(policyOptionHtml).join("");
      select.value = "/checkout||critical";
    }
    const [route, tier] = select.value.split("||");
    const policy = POLICY_MATRIX.find((p) => p.route === route && p.tier === tier) ?? POLICY_MATRIX[0];
    const denominator = Math.max(0, Math.floor(Number($("#calcDenominator").value) || 0));
    const numerator = Math.max(0, Math.floor(Number($("#calcNumerator").value) || 0));
    if (numerator > denominator) {
      $("#calculatorResult").innerHTML = `<p class="form-result error">\u5206\u5B50\u4E0D\u80FD\u5927\u4E8E\u5206\u6BCD\u3002</p>`;
      return;
    }
    const allowedErrors = denominator * (1 - policy.target);
    const consumedRatio = allowedErrors === 0 ? numerator > 0 ? Number.POSITIVE_INFINITY : 0 : numerator / allowedErrors;
    const view = { denominator, numerator, allowedErrors, consumedRatio: Number.isFinite(consumedRatio) ? consumedRatio : null };
    const level = classifyBudgetLevel(view);
    const remaining = allowedErrors - numerator;
    $("#calculatorResult").innerHTML = `
    <div class="big-level">${levelBadge(level)}</div>
    <div>
      <div class="calc-outputs">
        <div class="calc-output"><span>\u5141\u8BB8\u9519\u8BEF\u9884\u7B97</span><strong>${numberOrDash(allowedErrors)} \u7B14</strong></div>
        <div class="calc-output"><span>\u6D88\u8017\u7387</span><strong>${formatPercent(view.consumedRatio, 1)}</strong></div>
        <div class="calc-output"><span>\u5269\u4F59</span><strong class="${remaining < 0 ? "neg" : "pos"}">${signedNumber(remaining)} \u7B14</strong></div>
      </div>
      <div class="calc-bar">${budgetBar({ ...view, level })}</div>
    </div>
  `;
  }
  function render() {
    const model = engine.getDashboardModel();
    renderWindowStatus(model);
    renderStepper(model);
    renderKpis(model);
    renderGuard(model);
    renderBudgetList(model);
    renderRevisionCompare(model);
    renderOpsFeed(model);
    renderCorrections(model);
    renderAudit(model);
    renderCalculator();
  }
  function setNotice(text, type = "") {
    const notice = $("#actionNotice");
    notice.textContent = text;
    notice.className = `action-notice ${type}`.trim();
  }
  function runStep(stepId) {
    let result;
    if (stepId === "initial") {
      result = engine.ingestReport(buildInitialReport());
      setNotice(`v1 \u5DF2\u5165\u8D26\uFF1A${result.newRecordCount} \u6761\u552F\u4E00\u8BF7\u6C42\uFF1B\u5173\u952E\u4EA4\u6613\u9884\u7B97\u7ACB\u5373\u663E\u793A\u4E25\u91CD\u544A\u8B66\u3002`, "success");
    } else if (stepId === "duplicate") {
      result = engine.ingestReport({
        ...buildInitialReport(),
        receivedAt: DEMO_TIMES.duplicateReceivedAt
      });
      setNotice(result.message, result.status === "duplicate" ? "success" : "error");
    } else if (stepId === "revision") {
      result = engine.ingestReport(buildLateRevisionReport());
      setNotice("\u5BBD\u9650\u5185\u8FDF\u5230\u6279\u6B21\u5F62\u6210 r2\uFF1A\u5173\u952E\u4EA4\u6613\u4ECE 2/40 \u53D8\u4E3A 2/240\uFF0C\u4E25\u91CD\u544A\u8B66\u964D\u4E3A\u9884\u8B66\u3002", "success");
    } else if (stepId === "settle") {
      result = engine.settleWindow(DEMO_WINDOW.id, DEMO_TIMES.settleAt, "demo-watermark");
      setNotice(`\u7A97\u53E3\u5DF2\u7ED3\u7B97\uFF1A\u51BB\u7ED3 ${Object.keys(result.settlement.snapshots).length} \u4E2A\u9884\u7B97\u5207\u7247\uFF0C\u53D1\u5E03 ${result.settlement.messageIds.length} \u6761\u9884\u8B66/\u544A\u8B66\u3002`, "success");
    } else if (stepId === "too-late") {
      result = engine.ingestReport(buildTooLateReport());
      setNotice(`\u8FC7\u665A\u6279\u6B21\u5DF2\u5165\u8D26\u4F46\u4EC5\u4F5C\u66F4\u6B63\u5019\u9009\uFF1A${result.correctionIds.length} \u6761\u66F4\u6B63\u8BB0\u5F55\uFF1B\u6B63\u5F0F\u7ED3\u7B97\u672A\u6539\u53D8\u3002`, "success");
    } else if (stepId === "advisory") {
      const correction = [...engine.corrections.values()].find((c) => c.reportId === "rep-1000-too-late-failures");
      if (!correction) throw new Error("\u5C1A\u672A\u627E\u5230\u8FC7\u665A\u6570\u636E\u66F4\u6B63\u8BB0\u5F55");
      result = engine.publishCorrectionAdvisory(correction.id, { at: DEMO_TIMES.advisoryAt });
      setNotice("\u5DF2\u65B0\u589E\u4E00\u6761\u4EBA\u5DE5\u66F4\u6B63\u901A\u544A\uFF1B\u539F\u7ED3\u7B97\u544A\u8B66\u4ECD\u4FDD\u7559\u4E3A warning\uFF0C\u6CA1\u6709\u88AB\u9759\u9ED8\u8986\u76D6\u3002", "success");
    }
    render();
    return result;
  }
  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function initForms() {
    $("#manualPolicy").innerHTML = POLICY_MATRIX.map(policyOptionHtml).join("");
    $("#manualPolicy").value = "/checkout||critical";
    $("#primaryStepButton").addEventListener("click", () => {
      const stepId = $("#primaryStepButton").dataset.step;
      if (!stepId || autoRunning) return;
      try {
        runStep(stepId);
      } catch (error) {
        setNotice(error.message, "error");
      }
    });
    $("#resetButton").addEventListener("click", () => {
      if (autoRunning) return;
      engine = new BudgetEngine({ windows: [DEMO_WINDOW] });
      manualCounter = 0;
      openDetails.clear();
      setNotice("\u5DF2\u6E05\u7A7A\u3002\u70B9\u51FB\u201C\u4E0B\u4E00\u6B65\uFF1A\u4E0A\u62A5 v1 \u521D\u59CB\u6279\u6B21\u201D\u4ECE\u96F6\u6F14\u793A\u3002", "");
      render();
    });
    $("#autoDemoButton").addEventListener("click", async () => {
      if (autoRunning) return;
      autoRunning = true;
      engine = new BudgetEngine({ windows: [DEMO_WINDOW] });
      manualCounter = 0;
      openDetails.clear();
      render();
      const ids = DEMO_STEPS.map((s) => s.id);
      for (const id of ids) {
        try {
          runStep(id);
        } catch (error) {
          setNotice(error.message, "error");
          break;
        }
        await wait(950);
      }
      autoRunning = false;
      setNotice("\u81EA\u52A8\u6F14\u793A\u5B8C\u6210\uFF1A\u53EF\u5C55\u5F00\u9884\u7B97\u5361\u7247\u6838\u5BF9\u5206\u5B50\u3001\u5206\u6BCD\u548C\u6570\u636E\u7248\u672C\u3002", "success");
      render();
    });
    document.addEventListener("click", (event) => {
      const button = event.target.closest('[data-action="publish-advisory"]');
      if (!button) return;
      try {
        engine.publishCorrectionAdvisory(button.dataset.id, { at: (/* @__PURE__ */ new Date()).toISOString() });
        setNotice("\u66F4\u6B63\u901A\u544A\u5DF2\u53D1\u5E03\uFF1B\u6B63\u5F0F\u7ED3\u7B97\u5FEB\u7167\u4FDD\u6301\u4E0D\u53D8\u3002", "success");
        render();
      } catch (error) {
        setNotice(error.message, "error");
      }
    });
    document.addEventListener("toggle", (event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || !details.dataset.detailKey) return;
      if (details.open) openDetails.add(details.dataset.detailKey);
      else openDetails.delete(details.dataset.detailKey);
    }, true);
    $("#calculatorForm").addEventListener("input", renderCalculator);
    $("#calcPolicy").addEventListener("change", renderCalculator);
    $("#manualForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const resultNode = $("#manualResult");
      try {
        manualCounter += 1;
        const [route, tier] = $("#manualPolicy").value.split("||");
        const arrivalPreset = $("#manualArrival").value;
        const receivedAt = {
          "on-time": "2026-11-27T10:04:30.000Z",
          grace: DEMO_TIMES.revisedReceivedAt,
          late: DEMO_TIMES.lateReceivedAt
        }[arrivalPreset];
        const requestId = $("#manualRequestId").value.trim() || `manual-${String(manualCounter).padStart(3, "0")}`;
        const reportId = `manual-report-${String(manualCounter).padStart(3, "0")}`;
        const result = engine.ingestReport({
          reportId,
          receivedAt,
          windowId: DEMO_WINDOW.id,
          records: [
            {
              requestId,
              eventAt: "2026-11-27T10:02:30.000Z",
              route,
              tier,
              status: Number($("#manualStatus").value),
              latencyMs: Number($("#manualLatency").value)
            }
          ]
        });
        if (result.status === "conflict") {
          resultNode.className = "form-result error";
          resultNode.textContent = `${result.message} ${result.conflicts?.map((x) => x.reason).join("\uFF1B") ?? ""}`;
          setNotice("\u624B\u52A8\u4E0A\u62A5\u88AB\u62D2\u7EDD\uFF1A\u5E42\u7B49\u952E\u6216 requestId \u51B2\u7A81\u3002", "error");
        } else {
          resultNode.className = "form-result success";
          resultNode.textContent = result.message;
          setNotice(`\u624B\u52A8\u4E0A\u62A5 ${reportId} \u5DF2\u5904\u7406\u3002`, "success");
          $("#manualRequestId").value = "";
        }
        render();
      } catch (error) {
        resultNode.className = "form-result error";
        resultNode.textContent = error.message;
        setNotice(error.message, "error");
      }
    });
    $("#themeToggle").addEventListener("click", () => {
      const root = document.documentElement;
      const currentlyDark = root.dataset.theme === "dark" || !root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches;
      const next = currentlyDark ? "light" : "dark";
      root.dataset.theme = next;
      try {
        localStorage.setItem("eb-theme", next);
      } catch {
      }
      updateThemeButton();
    });
  }
  function updateThemeButton() {
    const saved = (() => {
      try {
        return localStorage.getItem("eb-theme");
      } catch {
        return null;
      }
    })();
    if (saved) document.documentElement.dataset.theme = saved;
    const dark = document.documentElement.dataset.theme === "dark" || !document.documentElement.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const button = $("#themeToggle");
    button.setAttribute("aria-pressed", String(dark));
    button.innerHTML = dark ? '<span aria-hidden="true">\u2600</span> \u5207\u6362\u6D45\u8272' : '<span aria-hidden="true">\u25D0</span> \u5207\u6362\u6DF1\u8272';
  }
  initForms();
  updateThemeButton();
  renderPolicyMatrix();
  render();
})();
