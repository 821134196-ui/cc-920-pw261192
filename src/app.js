import {
  BudgetEngine,
  DEMO_TIMES,
  DEMO_WINDOW,
  POLICY_MATRIX,
  classifyBudgetLevel,
  formatPercent,
} from './engine.js';
import {
  DEMO_STEPS,
  buildInitialReport,
  buildLateRevisionReport,
  buildTooLateReport,
} from './demo.js';

const $ = (selector) => document.querySelector(selector);

let engine = new BudgetEngine();
engine.ingestReport(buildInitialReport());
let manualCounter = 0;
let autoRunning = false;
const openDetails = new Set();

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const LEVEL_META = {
  healthy: { label: '健康', icon: '✓', cls: 'good' },
  warning: { label: '预警', icon: '▲', cls: 'warning' },
  serious: { label: '严重', icon: '◆', cls: 'serious' },
  critical: { label: '严重告警', icon: '✕', cls: 'critical' },
  'no-data': { label: '无数据', icon: '–', cls: 'neutral' },
};

function levelBadge(level, extra = '') {
  const meta = LEVEL_META[level] ?? LEVEL_META['no-data'];
  return `<span class="level-badge ${meta.cls} ${extra}"><span aria-hidden="true">${meta.icon}</span>${esc(meta.label)}</span>`;
}

function timeShort(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(11, 19);
}

function numberOrDash(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const rounded = Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value).toString() : value.toFixed(digits);
  return rounded;
}

function signedNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const normalized = Math.abs(value) < 1e-9 ? 0 : value;
  return `${normalized > 0 ? '+' : ''}${numberOrDash(normalized, digits)}`;
}

function timelinessLabel(value) {
  return {
    'on-time': '准时',
    'late-within-grace': '宽限内迟到',
    'late-beyond-cutoff': '超过截止线',
  }[value] ?? value ?? '—';
}

function reasonLabel(reason) {
  if (reason === '延迟') return '延迟超过策略阈值';
  return reason;
}

function policyOptionHtml(policy) {
  return `<option value="${esc(policy.route)}||${esc(policy.tier)}">${esc(policy.method)} ${esc(policy.route)} · ${esc(policy.tierLabel)} · SLO ${formatPercent(policy.target * 100 ? policy.target : policy.target, 1)}</option>`;
}

function budgetBar(view) {
  const ratio = view.consumedRatio ?? (view.numerator > 0 ? 1 : 0);
  const width = Math.max(0, Math.min(100, ratio * 100));
  const valueNow = Math.round(Math.min(100, ratio * 100));
  const valueText =
    view.consumedRatio === null
      ? `分母 ${view.denominator}，分子 ${view.numerator}，该 SLO 下允许错误数为 0`
      : `已消耗错误预算 ${formatPercent(view.consumedRatio, 1)}`;

  return `
    <div
      class="budget-bar"
      role="progressbar"
      aria-label="错误预算消耗率"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow="${valueNow}"
      aria-valuetext="${esc(valueText)}"
      title="${esc(valueText)}"
    >
      <div class="fill ${esc(view.level)}" style="width:${width}%"></div>
      <span class="tick warn" title="预警阈值 50%"></span>
      <span class="tick limit" title="预算耗尽 100%"></span>
    </div>
    <div class="bar-caption">
      <span>0</span>
      <span>预警 50%</span>
      <span>预算线 100%</span>
      <span><strong>${esc(formatPercent(view.consumedRatio, 1))}</strong></span>
    </div>
  `;
}

function versionCard(title, view, kind, footer = '') {
  if (!view) return '';
  return `
    <article class="version-card ${kind}">
      <h4>${esc(title)}</h4>
      <div class="v-row"><span>数据版本</span><strong class="mono">${esc(view.dataVersion)}</strong></div>
      <div class="v-row"><span>分子 / 分母</span><strong>${view.numerator} / ${view.denominator}</strong></div>
      <div class="v-row"><span>预算消耗</span><strong>${esc(formatPercent(view.consumedRatio, 1))}</strong></div>
      <div class="v-row"><span>剩余预算</span><strong>${esc(numberOrDash(view.remainingBudget))}</strong></div>
      <div class="v-row"><span>结论</span>${levelBadge(view.level)}</div>
      ${footer}
    </article>
  `;
}

function renderWindowStatus(model) {
  const window = model.windows[0];
  if (!window) {
    $('#windowStatus').innerHTML = '';
    return;
  }
  const cutoff = new Date(Date.parse(window.endAt) + (window.allowedLatenessMs ?? 120000)).toISOString();
  const settled = Boolean(window.settlement);
  const snapshotCount = window.settlement ? Object.keys(window.settlement.snapshots).length : 0;
  $('#windowStatus').innerHTML = `
    <div class="window-fact">
      <span>告警窗口</span>
      <strong>${esc(window.label)}</strong>
      <code>${esc(window.id)}</code>
    </div>
    <div class="window-fact">
      <span>数据时间范围</span>
      <strong>${timeShort(window.startAt)}–${timeShort(window.endAt)} UTC</strong>
      <small>事件时间落在左闭右开区间内才计入分母</small>
    </div>
    <div class="window-fact">
      <span>迟到准入截止线</span>
      <strong>${timeShort(cutoff)} UTC</strong>
      <small>截止线内可修订结算版本；之后仅作更正候选</small>
    </div>
    <div class="window-fact">
      <span>结算状态</span>
      <strong>${settled ? '已结算的告警窗口' : '未结算 · 仪表盘实时估值'}</strong>
      ${settled
        ? `<span class="badge badge-settled">${esc(window.settlement.id)} · ${snapshotCount} 个冻结切片 · ${timeShort(window.settlement.settledAt)} UTC</span>`
        : '<span class="badge badge-live">等待水位线 10:07 UTC</span>'}
    </div>
  `;
}

function renderStepper(model) {
  const hasReport = (id) => model.reports.some((r) => r.reportId === id);
  const states = {
    initial: hasReport('rep-1000-initial'),
    duplicate: model.audit.some((e) => e.type === 'report.duplicate_blocked'),
    revision: hasReport('rep-1000-late-successes'),
    settle: Boolean(model.windows[0]?.settlement),
    'too-late': hasReport('rep-1000-too-late-failures'),
    advisory: model.messages.some((m) => m.kind === 'correction-advisory'),
  };

  let firstIncompleteFound = false;
  $('#stepper').innerHTML = DEMO_STEPS.map((step, index) => {
    const done = states[step.id];
    let cls = 'step';
    if (done) cls += ' done';
    else if (!firstIncompleteFound) {
      cls += ' current';
      firstIncompleteFound = true;
    }
    return `
      <li class="${cls}" data-testid="step-${esc(step.id)}" data-done="${done}">
        <span class="step-number" aria-hidden="true">${done ? '✓' : index + 1}</span>
        <strong>${esc(step.label)}</strong>
        <p>${esc(step.description)}</p>
      </li>
    `;
  }).join('');

  const next = DEMO_STEPS.find((step) => !states[step.id]);
  const primary = $('#primaryStepButton');
  if (autoRunning) {
    primary.disabled = true;
    primary.textContent = '自动播放中…';
  } else if (next) {
    primary.disabled = false;
    primary.dataset.step = next.id;
    primary.textContent = `下一步：${next.label}`;
  } else {
    primary.disabled = true;
    primary.textContent = '全部演示步骤已完成';
    delete primary.dataset.step;
  }
  $('#autoDemoButton').disabled = autoRunning;
}

function renderKpis(model) {
  const settledAlerts = model.messages.filter((m) => m.kind === 'settled-alert').length;
  const items = [
    { label: '唯一请求记录', value: model.totals.records, hint: '按 requestId 去重' },
    { label: '已接受上报批次', value: model.totals.reports, hint: 'reportId 幂等键' },
    { label: '重复上报拦截', value: model.totals.duplicateReportAttempts, hint: '不改变分子分母/版本' },
    { label: '正式运营消息', value: model.totals.operationsMessages, hint: `${settledAlerts} 条结算告警，其余为显式通告` },
    { label: '更正台账', value: model.totals.corrections, hint: '过晚数据候选，不静默改判' },
  ];
  $('#kpiGrid').innerHTML = items
    .map(
      (item) => `
      <article class="kpi">
        <div class="kpi-label">${esc(item.label)}</div>
        <div class="kpi-value">${esc(item.value)}</div>
        <div class="kpi-hint">${esc(item.hint)}</div>
      </article>
    `,
    )
    .join('');
}

function renderGuard(model) {
  const settledWindow = model.windows.find((w) => w.settlement);
  const drifted = model.conclusions.filter(
    (c) => c.official && c.live.dataVersion !== c.official.dataVersion,
  );

  if (!model.conclusions.length) {
    $('#consistencyGuard').innerHTML = `
      <div class="guard ok" data-testid="empty-guard">
        <div class="guard-icon" aria-hidden="true">i</div>
        <div><h2>等待上报数据</h2><p>先执行第一步载入演示，或在右侧手动上报一条请求记录。</p></div>
      </div>`;
    return;
  }

  if (drifted.length) {
    const text = drifted
      .map((c) => {
        const p = c.live.policy;
        return `${p.method} ${c.route} · ${p.tierLabel}：正式 ${c.official.level}（${c.official.dataVersion}） / 实时候选 ${c.live.level}（${c.live.dataVersion}）`;
      })
      .join('；');
    $('#consistencyGuard').innerHTML = `
      <div class="guard" data-testid="drift-guard">
        <div class="guard-icon" aria-hidden="true">!</div>
        <div>
          <h2>实时估值已因过晚数据变化，但已结算告警没有被覆盖</h2>
          <p>${esc(text)}。差异只进入更正台账；运营端不会收到自动的矛盾改判，只能由值班同学显式发布更正通告。</p>
        </div>
      </div>`;
    return;
  }

  if (settledWindow) {
    $('#consistencyGuard').innerHTML = `
      <div class="guard ok" data-testid="settled-guard">
        <div class="guard-icon" aria-hidden="true">✓</div>
        <div>
          <h2>窗口已结算，正式结论已冻结</h2>
          <p>结算快照、分子分母、数据版本和告警消息均保持不变；后续迟到数据会单独形成更正记录。</p>
        </div>
      </div>`;
    return;
  }

  $('#consistencyGuard').innerHTML = `
    <div class="guard ok" data-testid="live-guard">
      <div class="guard-icon" aria-hidden="true">◔</div>
      <div>
        <h2>当前显示的是仪表盘实时估值</h2>
        <p>窗口尚未到水位线/未结算；宽限内迟到记录会创建新版本并允许估值和预估告警变化。结算后才产生不可静默撤回的运营告警。</p>
      </div>
    </div>`;
}

function renderBudgetCard(c) {
  const live = c.live;
  const official = c.official;
  const admitted = c.admitted;
  const primary = official ?? live;
  const hasPostCutoffBeforeSettlement = !official && admitted.dataVersion !== live.dataVersion;
  const secondary = official && official.dataVersion !== live.dataVersion
    ? live
    : hasPostCutoffBeforeSettlement
      ? admitted
      : null;
  const secondaryIsCandidate = Boolean(official);
  const policy = live.policy;
  const detailKey = `budget:${c.key}`;
  const isOpen = openDetails.has(detailKey);

  const reasonEntries = Object.entries(primary.reasonCounts ?? {});
  const errorRows = primary.errorRecords
    .map(
      (r) => `
      <tr>
        <td class="mono">${esc(r.requestId)}</td>
        <td class="mono">${timeShort(r.eventAt)}</td>
        <td>${esc(r.status)}</td>
        <td class="num">${esc(r.latencyMs)}ms</td>
        <td>${esc(r.failureReasons.join('；'))}</td>
      </tr>`,
    )
    .join('');

  const reportRows = primary.sourceReports
    .map(
      (r) => `
      <tr>
        <td class="mono">${esc(r.reportId)}</td>
        <td class="mono">${esc(r.contentHash)}</td>
        <td>${timeShort(r.receivedAt)}</td>
        <td>${esc(timelinessLabel(r.timeliness))}</td>
      </tr>`,
    )
    .join('');

  const historyRows = live.versionHistory
    .map(
      (v) => `
      <tr>
        <td><strong class="mono">${esc(v.dataVersion)}</strong></td>
        <td>${timeShort(v.at)}</td>
        <td class="num">${v.numerator}</td>
        <td class="num">${v.denominator}</td>
        <td class="num">${esc(formatPercent(v.consumedRatio, 1))}</td>
        <td>${levelBadge(v.level)}</td>
      </tr>`,
    )
    .join('');

  const idList = primary.recordIds.map((id) => `<code>${esc(id)}</code>`).join(' ');
  const secondaryIdList = secondary
    ? secondary.recordIds.map((id) => `<code>${esc(id)}</code>`).join(' ')
    : '';
  const excludedRows = primary.excludedRecords
    .map(
      (r) => `<li class="mono">${esc(r.requestId)} — ${esc(r.exclusionReason ?? 'excluded')}</li>`,
    )
    .join('');

  return `
    <details
      class="budget-card ${primary.level === 'critical' ? 'attention' : ''}"
      data-detail-key="${esc(detailKey)}"
      data-testid="budget-conclusion"
      data-budget-key="${esc(c.key)}"
      data-scope="${official ? 'official-settled' : 'live'}"
      data-level="${esc(primary.level)}"
      data-numerator="${primary.numerator}"
      data-denominator="${primary.denominator}"
      data-data-version="${esc(primary.dataVersion)}"
      ${official ? `data-official-version="${esc(official.dataVersion)}" data-official-level="${esc(official.level)}"` : ''}
      ${secondary ? `data-secondary-version="${esc(secondary.dataVersion)}" data-secondary-level="${esc(secondary.level)}"` : ''}
      ${isOpen ? 'open' : ''}
    >
      <summary class="budget-summary" data-testid="budget-expand">
        <div class="route-title-wrap">
          <div class="route-title">
            <span class="method">${esc(policy.method)}</span>
            <span class="route-path">${esc(policy.route)}</span>
            <span class="tier-tag">${esc(policy.tierLabel)} · ${esc(policy.tier)}</span>
          </div>
          <div class="budget-subline">${esc(live.windowId)} · SLO ${formatPercent(policy.target, 1)} · ${esc(policy.rationale)}</div>
        </div>

        <div class="primary-metric">
          <div class="metric-line">
            <span class="fraction"><span class="numerator">${primary.numerator}</span> / <span class="denominator">${primary.denominator}</span></span>
            <span>${levelBadge(primary.level)}</span>
            <span class="data-version">${esc(primary.dataVersion)}</span>
          </div>
          ${budgetBar(primary)}
          ${
            secondary
              ? `<div class="secondary-estimate" data-testid="secondary-estimate">
                   <span class="badge ${secondaryIsCandidate ? 'badge-live' : 'badge-settled'}">${secondaryIsCandidate ? '实时全量' : '截止线内准入口径'} ${esc(secondary.dataVersion)}</span>
                   <span>${secondary.numerator}/${secondary.denominator} · ${esc(formatPercent(secondary.consumedRatio, 1))}</span>
                   ${levelBadge(secondary.level)}
                   <span class="secondary-note">${secondaryIsCandidate ? '不覆盖左侧正式结论' : '结算时将冻结此口径；全量实时值见详情'}</span>
                 </div>`
              : `<div class="secondary-estimate"><span class="badge badge-live">${official ? '与结算快照一致' : '未结算 · 实时估值可修订'}</span></div>`
          }
        </div>

        <div class="summary-side">
          ${official ? '<span class="badge badge-settled">已结算正式口径</span>' : '<span class="badge badge-live">仪表盘实时估值</span>'}
          <span class="expand-hint">展开分子 / 分母 / 版本 ▾</span>
        </div>
      </summary>

      <div class="budget-details">
        <div class="version-strip">
          ${official ? versionCard('正式结算快照（不可变）', official, 'official', `<div class="v-row"><span>结算时间</span><strong>${timeShort(official.frozenAt)}</strong></div>`) : versionCard('仪表盘实时全量（未结算）', live, 'live')}
          ${official && secondaryIsCandidate && secondary ? versionCard('仪表盘实时全量（仅观测/更正候选）', secondary, 'candidate') : ''}
          ${!official && hasPostCutoffBeforeSettlement ? versionCard('截止线内准入口径（结算将冻结）', admitted, 'official') : ''}
        </div>

        <dl class="detail-grid">
          <div class="stat-box"><dt>分子：失败请求</dt><dd data-testid="numerator">${primary.numerator}</dd></div>
          <div class="stat-box"><dt>分母：合格请求</dt><dd data-testid="denominator">${primary.denominator}</dd></div>
          <div class="stat-box"><dt>成功请求</dt><dd>${primary.successCount}</dd></div>
          <div class="stat-box"><dt>SLO 目标</dt><dd>${formatPercent(primary.target, 2)}</dd></div>
          <div class="stat-box"><dt>允许错误预算</dt><dd>${numberOrDash(primary.allowedErrors)} 笔</dd></div>
          <div class="stat-box"><dt>剩余预算</dt><dd class="${primary.remainingBudget < 0 ? 'neg' : 'pos'}">${signedNumber(primary.remainingBudget)} 笔</dd></div>
        </dl>

        <div class="formula" data-testid="budget-formula">
          消耗率 = 分子 ÷ [分母 ×（1 − SLO）] =
          <strong>${primary.numerator}</strong> ÷
          [<strong>${primary.denominator}</strong> × ${(1 - primary.target).toFixed(4)}]
          = <strong>${esc(formatPercent(primary.consumedRatio, 2))}</strong>
          ；数据版本 <strong class="mono">${esc(primary.dataVersion)}</strong>
        </div>

        <div class="detail-columns">
          <section class="detail-block">
            <h4>成功标准与分子构成</h4>
            <ul class="criteria-list">
              ${policy.criteria.map((item) => `<li>${esc(item)}</li>`).join('')}
            </ul>
            ${
              reasonEntries.length
                ? `<div class="tags">${reasonEntries
                    .map(([reason, count]) => `<span class="badge critical">${esc(reasonLabel(reason))} × ${count}</span>`)
                    .join('')}</div>`
                : '<p class="muted-note">当前分子为 0，没有失败原因。</p>'
            }
            ${
              errorRows
                ? `<div class="table-wrap scroll-list"><table class="data-table">
                    <thead><tr><th>requestId</th><th>事件</th><th>状态</th><th>延迟</th><th>失败原因</th></tr></thead>
                    <tbody>${errorRows}</tbody>
                  </table></div>`
                : ''
            }
          </section>

          <section class="detail-block">
            <h4>分母来源与数据版本</h4>
            <p class="muted-note">下表只列出生成当前展开结论 <span class="mono">${esc(primary.dataVersion)}</span> 时实际采用的 reportId；重复上报和未采纳的过晚批次不会混入正式分母。</p>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>来源 reportId</th><th>批次哈希</th><th>接收</th><th>迟到分类</th></tr></thead>
                <tbody>${reportRows}</tbody>
              </table>
            </div>
            <h4>版本历史（当前账本可见，含未采纳候选）</h4>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>数据版本</th><th>时间</th><th>分子</th><th>分母</th><th>消耗</th><th>结论</th></tr></thead>
                <tbody>${historyRows}</tbody>
              </table>
            </div>
          </section>
        </div>

        <details class="raw-details">
          <summary>
            查看本结论（${official ? '正式结算口径' : '实时口径'} ${esc(primary.dataVersion)}）使用的
            ${primary.recordIds.length} 个 requestId 与排除记录
          </summary>
          <p class="id-list mono">${idList || '（无）'}</p>
          ${excludedRows ? `<h4>已排除（${primary.excludedRecords.length}）</h4><ul class="simple-list">${excludedRows}</ul>` : ''}
        </details>
        ${
          secondary
            ? `<details class="raw-details secondary-id-details">
                <summary>
                  查看${secondaryIsCandidate ? '实时全量候选' : '截止线内准入口径'}
                  （${esc(secondary.dataVersion)}）使用的 ${secondary.recordIds.length} 个 requestId
                </summary>
                <p class="id-list mono">${secondaryIdList || '（无）'}</p>
              </details>`
            : ''
        }
      </div>
    </details>
  `;
}

function renderBudgetList(model) {
  if (!model.conclusions.length) {
    $('#budgetList').innerHTML = `
      <div class="empty-state" data-testid="budget-empty">
        还没有任何合格请求。点击“下一步：上报 v1 初始批次”开始。
      </div>`;
    return;
  }

  const severityRank = { critical: 4, serious: 3, warning: 2, healthy: 1, 'no-data': 0 };
  const sorted = [...model.conclusions].sort((a, b) => {
    const primaryA = a.official ?? a.live;
    const primaryB = b.official ?? b.live;
    return severityRank[primaryB.level] - severityRank[primaryA.level] || a.key.localeCompare(b.key);
  });
  $('#budgetList').innerHTML = sorted.map(renderBudgetCard).join('');
}

function versionDisposition(entry, conclusion) {
  if (conclusion.official?.dataVersion === entry.dataVersion) {
    return { label: '已结算冻结', cls: 'settled' };
  }
  if (conclusion.official && entry.revision > conclusion.official.revision) {
    return { label: '更正候选 · 未采纳', cls: 'candidate' };
  }
  if (entry === conclusion.live.versionHistory.at(-1) && !conclusion.official) {
    return { label: '当前实时估值', cls: 'live' };
  }
  return { label: '已被新版本替代', cls: 'neutral' };
}

function renderRevisionCompare(model) {
  const focus =
    model.conclusions.find((c) => c.route === '/checkout' && c.tier === 'critical') ??
    model.conclusions.find((c) => c.live.versionHistory.length > 1);

  if (!focus) {
    $('#revisionCompare').innerHTML = `
      <div class="revision-scroll"><div class="empty-state">暂无版本。上报初始批次后，这里会展示 r1；宽限内迟到批次将演示告警如何降级。</div></div>`;
    return;
  }

  const entries = focus.live.versionHistory;
  const cards = entries
    .map((entry) => {
      const disposition = versionDisposition(entry, focus);
      return `
        <article class="flow-card" data-testid="revision-card" data-version="${esc(entry.dataVersion)}">
          <div class="flow-head">
            <span class="flow-title mono">${esc(entry.dataVersion)}</span>
            ${levelBadge(entry.level)}
          </div>
          <div class="flow-meta">${timeShort(entry.at)} · <span class="mono">${esc(entry.reportId)}</span></div>
          <p class="flow-numbers"><strong>${entry.numerator}</strong> 错误 / <strong>${entry.denominator}</strong> 请求 · 消耗 <strong>${esc(formatPercent(entry.consumedRatio, 1))}</strong></p>
          <span class="badge badge-${disposition.cls === 'neutral' ? 'neutral' : disposition.cls === 'live' ? 'live' : disposition.cls === 'settled' ? 'settled' : 'correction'}">${esc(disposition.label)}</span>
        </article>
      `;
    })
    .join('');

  const transitions = entries.slice(1).map((entry, index) => {
    const before = entries[index];
    return `
      <div class="transition-line" data-testid="revision-transition">
        <span class="mono">${esc(before.dataVersion)}</span>
        ${levelBadge(before.level)}
        <span class="mini-arrow" aria-hidden="true">→</span>
        <span class="mono">${esc(entry.dataVersion)}</span>
        ${levelBadge(entry.level)}
        <span class="transition-text">${
          focus.official && entry.revision > focus.official.revision
            ? '只改变实时试算/更正候选，正式告警不变'
            : focus.official?.dataVersion === entry.dataVersion
              ? '成为已结算正式结论'
              : '结算前的仪表盘预估告警随之修订'
        }</span>
      </div>`;
  });

  $('#revisionCompare').innerHTML = `
    <div class="revision-scroll">
      <div class="version-flow">${cards}</div>
      <div class="transition-list">${transitions.join('') || '<p class="muted-note">等待第二个数据版本。</p>'}</div>
    </div>
  `;
}

function renderOpsFeed(model) {
  if (!model.messages.length) {
    $('#opsFeed').innerHTML = `
      <div class="empty-state" data-testid="ops-empty">
        尚无运营端消息。<br />未结算前，仪表盘的实时估值和预估告警变化不会通知运营；结算时每个正式告警只发布一次。
      </div>`;
    return;
  }

  $('#opsFeed').innerHTML = model.messages
    .map((m) => {
      const severity = m.severity ?? 'neutral';
      const kindLabel =
        m.kind === 'settled-alert' ? '已结算告警 · 正式且不可静默改判' : '人工更正通告 · 新增消息，不覆盖原结论';
      return `
        <article class="message-card severity-${esc(severity)} kind-${esc(m.kind)}" data-testid="ops-message" data-message-id="${esc(m.id)}">
          <div class="message-head">
            <h3>${esc(m.title)}</h3>
            <time class="message-time" datetime="${esc(m.createdAt)}" title="${esc(m.createdAt)}">${timeShort(m.createdAt)} UTC</time>
          </div>
          <p>${esc(m.body)}</p>
          <div class="message-tags">
            <span class="badge ${esc(severity)}">${esc(LEVEL_META[severity]?.label ?? severity)}</span>
            <span class="badge ${m.kind === 'settled-alert' ? 'badge-settled' : 'badge-correction'}">${esc(kindLabel)}</span>
            <span class="badge neutral mono">${esc(m.id)}</span>
          </div>
        </article>`;
    })
    .join('');
}

function renderCorrections(model) {
  if (!model.corrections.length) {
    $('#correctionList').innerHTML = `
      <div class="empty-state" data-testid="correction-empty">
        超过准入截止线或在结算后到达的数据会保留在这里。系统可以计算“若纳入会怎样”，但不会静默替换正式结论。
      </div>`;
    return;
  }

  $('#correctionList').innerHTML = model.corrections
    .map((c) => {
      const published = c.status === 'advisory-published';
      return `
        <article class="correction-card status-${esc(c.status)}" data-testid="correction-item" data-correction-id="${esc(c.id)}">
          <div class="correction-head">
            <h3>${esc(c.route)} · ${esc(c.tier)} <span class="mono">${esc(c.id)}</span></h3>
            <time class="correction-time" datetime="${esc(c.receivedAt)}">${timeShort(c.receivedAt)} UTC</time>
          </div>
          <p>
            报告 <code>${esc(c.reportId)}</code>；原因：${esc(
              c.reason === 'post-settlement-late-data' ? '结算后迟到' : '超过准入截止线',
            )}；包含 ${c.recordIds.length} 条过晚记录。
          </p>
          <div class="diff-line">
            <span class="mono">${esc(c.diff.fromDataVersion ?? '无正式基线')}</span>
            ${levelBadge(c.diff.fromLevel)}
            <span class="mini-arrow" aria-hidden="true">→</span>
            <span class="mono">${esc(c.diff.toDataVersion)}</span>
            ${levelBadge(c.diff.toLevel)}
          </div>
          <p>分子变化 <strong>${signedNumber(c.diff.numeratorDelta, 0)}</strong>，分母变化 <strong>${signedNumber(c.diff.denominatorDelta, 0)}</strong>。</p>
          <div class="correction-tags">
            <span class="badge ${published ? 'good' : 'warning'}">${published ? '更正通告已发布' : '待人工复核'}</span>
            <span class="badge neutral">正式告警未被修改</span>
            ${
              published
                ? `<span class="badge badge-settled mono">${esc(c.advisoryMessageId)}</span>`
                : `<button class="btn btn-primary" type="button" data-action="publish-advisory" data-id="${esc(c.id)}" data-testid="publish-advisory-${esc(c.id)}">发布显式更正通告</button>`
            }
          </div>
          ${published && c.advisory ? `<p class="advisory-note">${esc(c.advisory.operator)} 于 ${timeShort(c.advisory.at)} 发布：${esc(c.advisory.note)}</p>` : ''}
        </article>`;
    })
    .join('');
}

function renderAudit(model) {
  if (!model.reports.length) {
    $('#reportTable').innerHTML = '<div class="empty-state">暂无上报批次。</div>';
  } else {
    $('#reportTable').innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>reportId</th><th>内容哈希</th><th>首次接收</th><th class="num">新记录</th><th>重复 requestId</th><th>到达分类</th></tr></thead>
          <tbody>
            ${model.reports
              .map(
                (r) => `
              <tr>
                <td class="mono">${esc(r.reportId)}</td>
                <td class="mono">${esc(r.contentHash)}</td>
                <td>${timeShort(r.receivedAt)} UTC</td>
                <td class="num">${r.newRecordCount}</td>
                <td>${r.duplicateRequestIds?.length ? esc(r.duplicateRequestIds.join(', ')) : '—'}</td>
                <td>${esc(timelinessLabel(r.timeliness))}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  const eventLabels = {
    'report.accepted': '上报已入账',
    'report.duplicate_blocked': '重复上报已拦截',
    'report.conflict': '上报冲突，整批拒绝',
    'estimate.revised': '实时估值已修订',
    'estimate.correction_preview_changed': '更正候选试算变化',
    'window.settled': '窗口已结算并冻结快照',
    'settle.idempotent_replay': '重复结算请求被忽略',
    'operations.alert_published_once': '运营告警已发布（仅一次）',
    'correction.recorded': '已建立更正记录',
    'correction.advisory_published': '人工更正通告已发布',
  };

  $('#auditTimeline').innerHTML = model.audit
    .slice()
    .reverse()
    .map((event) => {
      const cls = event.type.includes('duplicate') || event.type.includes('conflict')
        ? 'duplicate'
        : event.type.includes('settled')
          ? 'settled'
          : event.type.includes('correction')
            ? 'correction'
            : '';
      let summary = '';
      if (event.reportId) summary += `报告 ${event.reportId} `;
      if (event.budgetKey) summary += `预算 ${event.budgetKey.split('||').slice(1).join(' · ')} `;
      if (event.fromLevel && event.toLevel) summary += `${event.fromLevel} → ${event.toLevel}`;
      if (event.messageIds?.length) summary += `消息 ${event.messageIds.join(', ')}`;
      return `
        <article class="audit-event ${cls}" data-testid="audit-event" data-event-type="${esc(event.type)}">
          <div class="audit-event-time">${timeShort(event.at)} UTC · ${esc(event.id)}</div>
          <strong>${esc(eventLabels[event.type] ?? event.type)}</strong>
          ${summary ? `<p>${esc(summary)}</p>` : ''}
          <details class="raw-details">
            <summary>原始事件</summary>
            <pre class="json">${esc(JSON.stringify(event, null, 2))}</pre>
          </details>
        </article>`;
    })
    .join('');
}

function renderPolicyMatrix() {
  $('#policyMatrix').innerHTML = `
    <div class="table-wrap">
      <table class="data-table" data-testid="policy-table">
        <thead>
          <tr><th>路由</th><th>请求等级</th><th>SLO</th><th>成功标准</th><th>为什么这样区分</th></tr>
        </thead>
        <tbody>
          ${POLICY_MATRIX.map(
            (p) => `
            <tr>
              <td><span class="method">${esc(p.method)}</span> <code>${esc(p.route)}</code></td>
              <td><span class="tier-tag">${esc(p.tierLabel)}</span> <code>${esc(p.tier)}</code></td>
              <td><strong>${formatPercent(p.target, 1)}</strong></td>
              <td>${p.criteria.map((x) => esc(x)).join('<br />')}</td>
              <td>${esc(p.rationale)}</td>
            </tr>`,
          ).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderCalculator() {
  const select = $('#calcPolicy');
  if (!select.options.length) {
    select.innerHTML = POLICY_MATRIX.map(policyOptionHtml).join('');
    select.value = '/checkout||critical';
  }
  const [route, tier] = select.value.split('||');
  const policy = POLICY_MATRIX.find((p) => p.route === route && p.tier === tier) ?? POLICY_MATRIX[0];
  const denominator = Math.max(0, Math.floor(Number($('#calcDenominator').value) || 0));
  const numerator = Math.max(0, Math.floor(Number($('#calcNumerator').value) || 0));

  if (numerator > denominator) {
    $('#calculatorResult').innerHTML = `<p class="form-result error">分子不能大于分母。</p>`;
    return;
  }

  const allowedErrors = denominator * (1 - policy.target);
  const consumedRatio = allowedErrors === 0 ? (numerator > 0 ? Number.POSITIVE_INFINITY : 0) : numerator / allowedErrors;
  const view = { denominator, numerator, allowedErrors, consumedRatio: Number.isFinite(consumedRatio) ? consumedRatio : null };
  const level = classifyBudgetLevel(view);
  const remaining = allowedErrors - numerator;

  $('#calculatorResult').innerHTML = `
    <div class="big-level">${levelBadge(level)}</div>
    <div>
      <div class="calc-outputs">
        <div class="calc-output"><span>允许错误预算</span><strong>${numberOrDash(allowedErrors)} 笔</strong></div>
        <div class="calc-output"><span>消耗率</span><strong>${formatPercent(view.consumedRatio, 1)}</strong></div>
        <div class="calc-output"><span>剩余</span><strong class="${remaining < 0 ? 'neg' : 'pos'}">${signedNumber(remaining)} 笔</strong></div>
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

function setNotice(text, type = '') {
  const notice = $('#actionNotice');
  notice.textContent = text;
  notice.className = `action-notice ${type}`.trim();
}

function runStep(stepId) {
  let result;
  if (stepId === 'initial') {
    result = engine.ingestReport(buildInitialReport());
    setNotice(`v1 已入账：${result.newRecordCount} 条唯一请求；关键交易预算立即显示严重告警。`, 'success');
  } else if (stepId === 'duplicate') {
    result = engine.ingestReport({
      ...buildInitialReport(),
      receivedAt: DEMO_TIMES.duplicateReceivedAt,
    });
    setNotice(result.message, result.status === 'duplicate' ? 'success' : 'error');
  } else if (stepId === 'revision') {
    result = engine.ingestReport(buildLateRevisionReport());
    setNotice('宽限内迟到批次形成 r2：关键交易从 2/40 变为 2/240，严重告警降为预警。', 'success');
  } else if (stepId === 'settle') {
    result = engine.settleWindow(DEMO_WINDOW.id, DEMO_TIMES.settleAt, 'demo-watermark');
    setNotice(`窗口已结算：冻结 ${Object.keys(result.settlement.snapshots).length} 个预算切片，发布 ${result.settlement.messageIds.length} 条预警/告警。`, 'success');
  } else if (stepId === 'too-late') {
    result = engine.ingestReport(buildTooLateReport());
    setNotice(`过晚批次已入账但仅作更正候选：${result.correctionIds.length} 条更正记录；正式结算未改变。`, 'success');
  } else if (stepId === 'advisory') {
    const correction = [...engine.corrections.values()].find((c) => c.reportId === 'rep-1000-too-late-failures');
    if (!correction) throw new Error('尚未找到过晚数据更正记录');
    result = engine.publishCorrectionAdvisory(correction.id, { at: DEMO_TIMES.advisoryAt });
    setNotice('已新增一条人工更正通告；原结算告警仍保留为 warning，没有被静默覆盖。', 'success');
  }
  render();
  return result;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function initForms() {
  $('#manualPolicy').innerHTML = POLICY_MATRIX.map(policyOptionHtml).join('');
  $('#manualPolicy').value = '/checkout||critical';

  $('#primaryStepButton').addEventListener('click', () => {
    const stepId = $('#primaryStepButton').dataset.step;
    if (!stepId || autoRunning) return;
    try {
      runStep(stepId);
    } catch (error) {
      setNotice(error.message, 'error');
    }
  });

  $('#resetButton').addEventListener('click', () => {
    if (autoRunning) return;
    engine = new BudgetEngine({ windows: [DEMO_WINDOW] });
    manualCounter = 0;
    openDetails.clear();
    setNotice('已清空。点击“下一步：上报 v1 初始批次”从零演示。', '');
    render();
  });

  $('#autoDemoButton').addEventListener('click', async () => {
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
        setNotice(error.message, 'error');
        break;
      }
      await wait(950);
    }
    autoRunning = false;
    setNotice('自动演示完成：可展开预算卡片核对分子、分母和数据版本。', 'success');
    render();
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="publish-advisory"]');
    if (!button) return;
    try {
      engine.publishCorrectionAdvisory(button.dataset.id, { at: new Date().toISOString() });
      setNotice('更正通告已发布；正式结算快照保持不变。', 'success');
      render();
    } catch (error) {
      setNotice(error.message, 'error');
    }
  });

  document.addEventListener('toggle', (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.dataset.detailKey) return;
    if (details.open) openDetails.add(details.dataset.detailKey);
    else openDetails.delete(details.dataset.detailKey);
  }, true);

  $('#calculatorForm').addEventListener('input', renderCalculator);
  $('#calcPolicy').addEventListener('change', renderCalculator);

  $('#manualForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const resultNode = $('#manualResult');
    try {
      manualCounter += 1;
      const [route, tier] = $('#manualPolicy').value.split('||');
      const arrivalPreset = $('#manualArrival').value;
      const receivedAt = {
        'on-time': '2026-11-27T10:04:30.000Z',
        grace: DEMO_TIMES.revisedReceivedAt,
        late: DEMO_TIMES.lateReceivedAt,
      }[arrivalPreset];

      const requestId = $('#manualRequestId').value.trim() || `manual-${String(manualCounter).padStart(3, '0')}`;
      const reportId = `manual-report-${String(manualCounter).padStart(3, '0')}`;
      const result = engine.ingestReport({
        reportId,
        receivedAt,
        windowId: DEMO_WINDOW.id,
        records: [
          {
            requestId,
            eventAt: '2026-11-27T10:02:30.000Z',
            route,
            tier,
            status: Number($('#manualStatus').value),
            latencyMs: Number($('#manualLatency').value),
          },
        ],
      });

      if (result.status === 'conflict') {
        resultNode.className = 'form-result error';
        resultNode.textContent = `${result.message} ${result.conflicts?.map((x) => x.reason).join('；') ?? ''}`;
        setNotice('手动上报被拒绝：幂等键或 requestId 冲突。', 'error');
      } else {
        resultNode.className = 'form-result success';
        resultNode.textContent = result.message;
        setNotice(`手动上报 ${reportId} 已处理。`, 'success');
        $('#manualRequestId').value = '';
      }
      render();
    } catch (error) {
      resultNode.className = 'form-result error';
      resultNode.textContent = error.message;
      setNotice(error.message, 'error');
    }
  });

  $('#themeToggle').addEventListener('click', () => {
    const root = document.documentElement;
    const currentlyDark = root.dataset.theme === 'dark' || (!root.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const next = currentlyDark ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('eb-theme', next);
    } catch {
      // 隐私模式下忽略。
    }
    updateThemeButton();
  });
}

function updateThemeButton() {
  const saved = (() => {
    try {
      return localStorage.getItem('eb-theme');
    } catch {
      return null;
    }
  })();
  if (saved) document.documentElement.dataset.theme = saved;
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const button = $('#themeToggle');
  button.setAttribute('aria-pressed', String(dark));
  button.innerHTML = dark ? '<span aria-hidden="true">☀</span> 切换浅色' : '<span aria-hidden="true">◐</span> 切换深色';
}

initForms();
updateThemeButton();
renderPolicyMatrix();
render();
