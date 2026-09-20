import type { AppApi } from '../../preload/index.js';
import type { DatabaseSettingsState } from '../../shared/database.js';
import type {
  DatabaseAgentJobSummary,
  DatabaseColumnMatch,
  DatabaseColumnProfileResult,
  DatabaseDeadlockHistoryResult,
  DatabaseFieldConsumersResult,
  DatabaseIncidentHistoryResult,
  DatabaseIncidentCauseTraceResult,
  DatabaseIncidentSnapshot,
  DatabaseIncidentWatchStatus,
  DatabaseJobsResult,
  DatabaseLiveRequest,
  DatabaseLivePerformanceResult,
  DatabaseQueryStoreResult,
  DatabaseSchemaCompareResult,
  DatabaseServerIncidentHistoryResult,
  DatabaseSourceTraceResult
} from '../investigation/types.js';
import { el, run, toast } from '../../renderer/dom.js';
import { databaseLanguage, t } from './i18n.js';
import './database-investigator.css';

const api = (window as Window & { api: AppApi }).api;

type InvestigatorTab = 'incident' | 'column' | 'performance' | 'schema' | 'jobs';
type PerformanceMode = 'live' | 'query-store' | 'deadlocks';
type CompareScope = 'all' | 'structure' | 'sql-code';

const TABS: ReadonlyArray<{ id: InvestigatorTab; label: string }> = [
  { id: 'incident', label: 'Incident' },
  { id: 'column', label: 'Field & Flow' },
  { id: 'performance', label: 'Performance' },
  { id: 'schema', label: 'Compare' }
];

let root: HTMLElement | null = null;
let body: HTMLElement | null = null;
let settings: DatabaseSettingsState | null = null;
let selectedConnection = '';
let activeTab: InvestigatorTab = 'incident';
let selectedColumn: DatabaseColumnMatch | null = null;
let columnMatches: DatabaseColumnMatch[] = [];
let columnProfile: DatabaseColumnProfileResult | null = null;
let flowResult: DatabaseFieldConsumersResult | null = null;
let performanceResult: DatabaseLivePerformanceResult | null = null;
let queryStoreResult: DatabaseQueryStoreResult | null = null;
let deadlockResult: DatabaseDeadlockHistoryResult | null = null;
let sourceTraceResult: DatabaseSourceTraceResult | null = null;
let jobsResult: DatabaseJobsResult | null = null;
let schemaResult: DatabaseSchemaCompareResult | null = null;
let incidentHistory: DatabaseIncidentHistoryResult | null = null;
let incidentWatchStatus: DatabaseIncidentWatchStatus | null = null;
let incidentCauseTraceResult: DatabaseIncidentCauseTraceResult | null = null;
let incidentCauseSessionId: number | null = null;
let selectedIncidentSnapshotId = '';
let serverIncidentHistory: DatabaseServerIncidentHistoryResult | null = null;
let serverIncidentHistoryAttempted = false;
let serverIncidentHistoryError: string | null = null;
let busy = false;
let performanceMode: PerformanceMode = 'live';
let compareScope: CompareScope = 'all';
let schemaBaselineConnection = '';
let schemaCurrentConnection = '';

const SOURCE_ROOT_KEY = 'cos.erp.database.sourceRoot';

function locale(): string {
  return databaseLanguage() === 'vi' ? 'vi-VN' : 'en-US';
}

function number(value: number): string {
  return Math.round(value).toLocaleString(locale());
}

function decimal(value: number, digits = 1): string {
  return value.toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function mb(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1024) return `${decimal(value / 1024, 2)} GB`;
  return `${decimal(value, 1)} MB`;
}

function dateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale());
}

function durationMs(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${decimal(value / 1000, 1)} s`;
  return `${decimal(value / 60_000, 1)} min`;
}

function button(text: string, action: () => void, primary = false): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = primary ? 'btn is-primary' : 'btn';
  node.textContent = t(text);
  node.addEventListener('click', action);
  return node;
}

function actionMenu(label: string, items: Array<{ label: string; action: () => void; active?: boolean }>): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'database-investigator-menu';
  const summary = document.createElement('summary');
  summary.className = 'btn';
  summary.dataset.dbLabel = label;
  summary.textContent = `${t(label)} ▾`;
  const menu = el('div', 'database-investigator-menu-popover');
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `database-investigator-menu-item${item.active ? ' is-active' : ''}`;
    node.dataset.dbLabel = item.label;
    node.setAttribute('role', 'menuitem');
    node.textContent = t(item.label);
    node.addEventListener('click', () => {
      details.open = false;
      item.action();
    });
    menu.append(node);
  }
  details.append(summary, menu);
  return details;
}

function titlebar(title: string, detail: string, actions: HTMLElement[] = []): HTMLElement {
  const bar = el('div', 'database-investigator-titlebar');
  const copy = el('div');
  copy.append(el('h3', '', () => t(title)), el('p', '', () => t(detail)));
  bar.append(copy);
  if (actions.length) {
    const actionBox = el('div', 'database-investigator-actions');
    actionBox.append(...actions);
    bar.append(actionBox);
  }
  return bar;
}

function stateMessage(message: string, isError = false): HTMLElement {
  return el('div', `database-investigator-state${isError ? ' is-error' : ''}`, () => t(message));
}

function metric(label: string, value: string, tone: '' | 'is-warn' | 'is-bad' = ''): HTMLElement {
  const card = el('div', `database-investigator-metric${tone ? ` ${tone}` : ''}`);
  card.append(el('span', '', () => t(label)), el('strong', '', value));
  return card;
}

function limitations(items: readonly string[]): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'database-investigator-limitations';
  for (const item of items) list.append(el('li', '', item));
  return list;
}

function chip(text: string, tone = ''): HTMLElement {
  return el('span', `database-investigator-chip${tone ? ` ${tone}` : ''}`, text);
}

function table(headers: string[], rows: Array<Array<string | HTMLElement>>, className = ''): HTMLElement {
  const scroll = el('div', 'database-investigator-table-scroll');
  const node = document.createElement('table');
  node.className = `database-investigator-table${className ? ` ${className}` : ''}`;
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const header of headers) headRow.append(el('th', '', () => t(header)));
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  for (const cells of rows) {
    const row = document.createElement('tr');
    for (const value of cells) {
      const cell = document.createElement('td');
      if (typeof value === 'string') cell.textContent = value;
      else cell.append(value);
      row.append(cell);
    }
    tbody.append(row);
  }
  node.append(thead, tbody);
  scroll.append(node);
  return scroll;
}

function populateConnectionSelect(select: HTMLSelectElement, preferred = ''): void {
  const profiles = settings?.settings.connections ?? [];
  select.replaceChildren(...profiles.map(profile => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} · ${profile.database}`;
    return option;
  }));
  const desired = preferred || selectedConnection || settings?.settings.defaultConnectionId || profiles[0]?.id || '';
  if (profiles.some(profile => profile.id === desired)) select.value = desired;
}

function resetConnectionScopedEvidence(): void {
  selectedColumn = null;
  columnMatches = [];
  columnProfile = null;
  flowResult = null;
  performanceResult = null;
  queryStoreResult = null;
  deadlockResult = null;
  sourceTraceResult = null;
  jobsResult = null;
  incidentHistory = null;
  incidentWatchStatus = null;
  incidentCauseTraceResult = null;
  incidentCauseSessionId = null;
  selectedIncidentSnapshotId = '';
  serverIncidentHistory = null;
  serverIncidentHistoryAttempted = false;
  serverIncidentHistoryError = null;
}

function renderTabs(): void {
  if (!root) return;
  for (const node of root.querySelectorAll<HTMLButtonElement>('.database-investigator-tab')) {
    node.classList.toggle('is-active', node.dataset.investigatorTab === activeTab);
    node.setAttribute('aria-selected', String(node.dataset.investigatorTab === activeTab));
    const config = TABS.find(item => item.id === node.dataset.investigatorTab);
    if (config) node.textContent = t(config.label);
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-db-label]')) {
    const label = node.dataset.dbLabel;
    if (!label) continue;
    node.textContent = node.tagName === 'SUMMARY' ? `${t(label)} ▾` : t(label);
  }
}

function selectTab(tab: InvestigatorTab): void {
  activeTab = tab;
  renderTabs();
  renderBody();
  if (tab === 'incident' && selectedConnection && incidentWatchStatus?.connection !== selectedConnection) {
    void loadIncidentWatchStatus();
  }
}

function openPerformanceTool(mode: PerformanceMode): void {
  performanceMode = mode;
  selectTab('performance');
}

function openCompareTool(scope: CompareScope): void {
  compareScope = scope;
  selectTab('schema');
}

function investigatorToolsMenu(): HTMLDetailsElement {
  return actionMenu('Tools', [
    { label: 'Incident Snapshot', action: () => selectTab('incident') },
    { label: 'Field & C#/WinForms trace', action: () => selectTab('column') },
    { label: 'Live Performance', action: () => openPerformanceTool('live') },
    { label: 'Query Store history', action: () => openPerformanceTool('query-store') },
    { label: 'Deadlock history', action: () => openPerformanceTool('deadlocks') },
    { label: 'Procedure & View Compare', action: () => openCompareTool('sql-code') },
    { label: 'Table & Index Compare', action: () => openCompareTool('structure') },
    { label: 'SQL Agent Jobs', action: () => selectTab('jobs') }
  ]);
}

function incidentSummary(snapshot: DatabaseIncidentSnapshot): HTMLElement {
  const grid = el('div', 'database-investigator-grid');
  grid.append(
    metric('Total size', mb(snapshot.summary.totalMb)),
    metric('Log used', snapshot.summary.logUsedPercent === null ? '—' : `${decimal(snapshot.summary.logUsedPercent, 1)}%`, (snapshot.summary.logUsedPercent ?? 0) >= 90 ? 'is-bad' : ''),
    metric('Active requests', number(snapshot.summary.activeRequestCount)),
    metric('Blocked', number(snapshot.summary.blockedRequestCount), snapshot.summary.blockedRequestCount > 0 ? 'is-bad' : ''),
    metric('Failed jobs', snapshot.summary.failedJobCount === null ? '—' : number(snapshot.summary.failedJobCount), (snapshot.summary.failedJobCount ?? 0) > 0 ? 'is-warn' : '')
  );
  return grid;
}

type IncidentSession = Partial<DatabaseLiveRequest> & Pick<DatabaseLiveRequest, 'sessionId'> & {
  reasons?: readonly string[];
  runningStatement?: string | null;
};

type DatabaseServerHistoryApi = AppApi & {
  readDatabaseServerIncidentHistory?: (id: string) => Promise<
    { ok: true; data: DatabaseServerIncidentHistoryResult } | { ok: false; error: string }
  >;
};

const INCIDENT_REASON_LABELS: ReadonlyArray<{ bit: number; id: string; label: string; tone: string }> = [
  { bit: 1, id: 'blocked', label: 'Blocked', tone: 'is-danger' },
  { bit: 2, id: 'long-request', label: 'Long request', tone: 'is-medium' },
  { bit: 4, id: 'long-transaction', label: 'Long transaction', tone: 'is-medium' },
  { bit: 8, id: 'blocking-chain', label: 'Blocking chain', tone: 'is-danger' }
];

function optionalDurationMs(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? durationMs(Math.max(0, value)) : '—';
}

function transactionAge(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? durationMs(Math.max(0, value) * 1000) : '—';
}

function reasonChips(session: IncidentSession): HTMLElement {
  const wrap = el('span', 'database-incident-reasons');
  const explicit = new Set(session.reasons ?? []);
  const mask = typeof session.reasonMask === 'number' ? session.reasonMask : 0;
  for (const reason of INCIDENT_REASON_LABELS) {
    if ((mask & reason.bit) !== 0 || explicit.has(reason.id)) wrap.append(chip(t(reason.label), reason.tone));
  }
  if (!wrap.childElementCount && (session.isBlocked === true || (session.blockingSessionId ?? 0) !== 0)) {
    wrap.append(chip(t('Blocked'), 'is-danger'));
  }
  if (session.isRootBlocker) wrap.append(chip(t('Root blocker'), 'is-danger'));
  else if (session.isBlocker) wrap.append(chip(t('Blocker'), 'is-medium'));
  if (session.isSleepingTransaction) wrap.append(chip(t('Sleeping transaction'), 'is-medium'));
  return wrap;
}

function fact(label: string, value: string): HTMLElement {
  const node = el('div', 'database-session-fact');
  node.append(el('span', '', () => t(label)), el('strong', '', value || '—'));
  return node;
}

function blockerText(session: IncidentSession): string {
  const blocker = session.blockingSessionId ?? 0;
  if (blocker > 0) return t('Session') + ' ' + blocker;
  if (blocker < 0) return t('Special blocker') + ' ' + blocker;
  return session.isRootBlocker ? t('Root blocker') : '—';
}

function sessionDetails(session: IncidentSession): HTMLElement {
  const details = el('div', 'database-session-detail');
  const facts = el('div', 'database-session-facts');
  facts.append(
    fact('Login', session.login ?? '—'),
    fact('Host', session.host ?? '—'),
    fact('Program', session.program ?? '—'),
    fact('Database', session.database ?? '—'),
    fact('Status', session.status ?? '—'),
    fact('Command', session.command ?? '—'),
    fact('Blocked by', blockerText(session)),
    fact('Wait', session.waitType ?? session.lastWaitType ?? '—'),
    fact('Wait resource', session.waitResource ?? '—'),
    fact('Wait time', optionalDurationMs(session.waitMs)),
    fact('Transaction age', transactionAge(session.transactionAgeSeconds)),
    fact('Open transactions', typeof session.openTransactionCount === 'number' ? number(session.openTransactionCount) : '—'),
    fact('Transaction began', dateTime(session.transactionBeginTime ?? null)),
    fact('Elapsed', optionalDurationMs(session.elapsedMs)),
    fact('CPU', optionalDurationMs(session.cpuMs)),
    fact('Logical reads', typeof session.logicalReads === 'number' ? number(session.logicalReads) : '—'),
    fact('Writes', typeof session.writes === 'number' ? number(session.writes) : '—')
  );
  if (session.queryHash) facts.append(fact('Query hash', session.queryHash));
  if (session.queryPlanHash) facts.append(fact('Plan hash', session.queryPlanHash));
  details.append(facts);
  if (session.runningStatement) {
    details.append(el('span', 'database-incident-sql-label', () => t('Running statement')));
    details.append(el('pre', 'database-incident-sql', session.runningStatement));
  }
  if (session.sql && session.sql !== session.runningStatement) {
    details.append(el('span', 'database-incident-sql-label', () => t('SQL text')));
    details.append(el('pre', 'database-incident-sql', session.sql));
  }
  if (session.runningStatement?.trim() || session.sql?.trim()) {
    const actions = el('div', 'database-investigator-actions database-incident-session-actions');
    const trace = button('Trace ERP cause', () => void traceIncidentCause(session));
    trace.classList.add('database-incident-trace');
    trace.dataset.sessionId = String(session.sessionId);
    actions.append(trace);
    details.append(actions);
  }
  return details;
}

function sortSessions(items: IncidentSession[]): IncidentSession[] {
  return items.sort((left, right) =>
    Number(right.isRootBlocker === true) - Number(left.isRootBlocker === true)
    || Number(right.isBlocker === true) - Number(left.isBlocker === true)
    || left.sessionId - right.sessionId);
}

function renderBlockingNode(
  session: IncidentSession,
  childrenByParent: ReadonlyMap<number, IncidentSession[]>,
  rendered: Set<number>,
  ancestry: ReadonlySet<number>
): HTMLElement {
  const node = el('article', 'database-blocking-node' + (session.isRootBlocker ? ' is-root' : '') + (session.isBlocked ? ' is-blocked' : ''));
  node.dataset.sessionId = String(session.sessionId);
  const details = document.createElement('details');
  details.className = 'database-blocking-session';
  details.open = session.isRootBlocker === true || session.isBlocked === true || session.isSleepingTransaction === true;
  const summary = document.createElement('summary');
  const headline = el('span', 'database-blocking-headline');
  headline.append(
    el('strong', '', t('Session') + ' ' + session.sessionId),
    el('small', '', (session.status ?? 'unknown') + ' · ' + (session.command ?? '—'))
  );
  summary.append(headline, reasonChips(session));
  details.append(summary, sessionDetails(session));
  rendered.add(session.sessionId);

  const nextAncestry = new Set(ancestry);
  nextAncestry.add(session.sessionId);
  const children = childrenByParent.get(session.sessionId) ?? [];
  if (children.length) {
    const branch = el('div', 'database-blocking-children');
    for (const child of sortSessions([...children])) {
      if (nextAncestry.has(child.sessionId)) {
        branch.append(el('div', 'database-blocking-cycle', t('Blocking cycle') + ' · ' + t('Session') + ' ' + child.sessionId));
        continue;
      }
      branch.append(renderBlockingNode(child, childrenByParent, rendered, nextAncestry));
    }
    details.append(branch);
  }
  node.append(details);
  return node;
}

function blockingHierarchy(sessions: readonly IncidentSession[], heading = 'Blocking hierarchy'): HTMLElement {
  const panel = el('section', 'database-incident-evidence');
  const head = el('div', 'database-incident-evidence-head');
  head.append(el('h5', '', () => t(heading)), el('span', '', number(sessions.length) + ' ' + t('sessions')));
  panel.append(head);
  if (!sessions.length) {
    panel.append(el('div', 'database-incident-empty', () => t('No captured session evidence.')));
    return panel;
  }

  const byId = new Map<number, IncidentSession>();
  for (const session of sessions) {
    if (Number.isFinite(session.sessionId) && !byId.has(session.sessionId)) byId.set(session.sessionId, session);
  }
  const childrenByParent = new Map<number, IncidentSession[]>();
  const roots: IncidentSession[] = [];
  for (const session of byId.values()) {
    const parent = session.blockingSessionId ?? 0;
    if (parent > 0 && parent !== session.sessionId && byId.has(parent)) {
      const children = childrenByParent.get(parent) ?? [];
      children.push(session);
      childrenByParent.set(parent, children);
    } else {
      roots.push(session);
    }
  }

  const tree = el('div', 'database-blocking-tree');
  const rendered = new Set<number>();
  for (const rootSession of sortSessions(roots)) {
    tree.append(renderBlockingNode(rootSession, childrenByParent, rendered, new Set()));
  }
  for (const session of sortSessions([...byId.values()].filter(item => !rendered.has(item.sessionId)))) {
    tree.append(renderBlockingNode(session, childrenByParent, rendered, new Set()));
  }
  panel.append(tree);
  return panel;
}

function incidentSnapshotCard(snapshot: DatabaseIncidentSnapshot): HTMLElement {
  const card = el('section', 'database-investigator-card database-incident-snapshot-detail');
  card.append(el('h4', '', () => t('Captured {0}', [dateTime(snapshot.capturedAt)])), incidentSummary(snapshot));
  if (snapshot.findings.length) {
    card.append(table(['Status', 'Evidence'], snapshot.findings.slice(0, 12).map(item => [item.severity.toUpperCase(), item.title + ': ' + item.detail])));
  }
  card.append(blockingHierarchy(snapshot.requests ?? [], 'Saved session evidence'));
  if (snapshot.limitations.length) card.append(limitations(snapshot.limitations));
  return card;
}

function incidentWatchPanel(): HTMLElement {
  const panel = el('section', 'database-investigator-card database-incident-watch');
  const head = el('div', 'database-incident-watch-head');
  const copy = el('div');
  copy.append(
    el('h4', '', () => t('Incident Black Box')),
    el('p', '', () => t('Watch checks live SQL Server sessions every 10 seconds and saves only meaningful incident changes.'))
  );
  head.append(copy);
  panel.append(head);
  if (!incidentWatchStatus) {
    panel.append(el('div', 'database-incident-empty', () => t('Watch status is loading.')));
    return panel;
  }
  const status = incidentWatchStatus;
  const grid = el('div', 'database-investigator-grid');
  grid.append(
    metric('Watch status', t(status.watching ? 'Watching' : 'Stopped'), status.watching ? 'is-warn' : ''),
    metric('Current incident', t(status.incidentActive ? 'Detected' : 'None'), status.incidentActive ? 'is-bad' : ''),
    metric('Last check', dateTime(status.lastCheckedAt)),
    metric('Last capture', dateTime(status.lastCapturedAt)),
    metric('Watch captures', number(status.capturedCount)),
    metric('Check interval', durationMs(status.intervalMs))
  );
  panel.append(grid);
  if (status.lastError) panel.append(el('div', 'database-incident-empty is-error', status.lastError));
  else panel.append(el('p', 'database-incident-watch-note', () => t('Repeated checks with the same blocker/query fingerprint are not saved again. When the incident clears, the same problem can be captured again if it returns.')));
  return panel;
}

function incidentCauseTracePanel(result: DatabaseIncidentCauseTraceResult): HTMLElement {
  const panel = el('section', 'database-investigator-card database-incident-cause');
  panel.append(el('h4', '', () => t('ERP Cause Trace · Session {0}', [incidentCauseSessionId ?? '—'])));
  if (result.candidates.length) {
    panel.append(table(['Kind', 'Candidate', 'Confidence', 'Evidence'], result.candidates.map(candidate => [
      t(candidate.kind),
      [candidate.schema, candidate.table && candidate.kind === 'column' ? candidate.table : null, candidate.name]
        .filter(Boolean).join('.'),
      chip(t(candidate.confidence), `is-${candidate.confidence}`),
      candidate.evidence
    ])));
  } else {
    panel.append(stateMessage('No reliable database object candidate was found in this SQL statement.'));
  }

  if (result.confirmedField) {
    const confirmed = result.confirmedField;
    const confirmedBox = el('div', 'database-incident-confirmed-field');
    const confirmedCopy = el('div');
    confirmedCopy.append(
      el('strong', '', `${confirmed.schema}.${confirmed.table}.${confirmed.column}`),
      el('small', '', () => t('Confirmed against current database metadata'))
    );
    confirmedBox.append(
      confirmedCopy,
      button('Open in Field & Flow', () => {
        selectedColumn = confirmed;
        columnMatches = [confirmed];
        columnProfile = null;
        flowResult = null;
        sourceTraceResult = null;
        selectTab('column');
      }, true)
    );
    panel.append(confirmedBox);
  }

  if (result.consumers.length) {
    panel.append(el('h4', '', () => t('SQL consumers')));
    panel.append(table(['Consumer', 'Type', 'Confidence', 'Evidence'], result.consumers.map(consumer => [
      `${consumer.schema}.${consumer.name}`,
      consumer.type,
      chip(t(consumer.confidence), `is-${consumer.confidence}`),
      consumer.reason
    ])));
  }

  if (result.source) {
    panel.append(el('h4', '', () => t('C#/WinForms source evidence')));
    const summary = el('div', 'database-investigator-grid');
    summary.append(
      metric('Files searched', number(result.source.searchedFiles)),
      metric('Matches', number(result.source.matches.length)),
      metric('Skipped', number(result.source.skippedFiles)),
      metric('Duration', durationMs(result.source.elapsedMs))
    );
    panel.append(summary);
    if (result.source.matches.length) {
      panel.append(table(['Kind', 'File', 'Line', 'Evidence', 'Confidence'], result.source.matches.map(match => [
        t(match.kind),
        match.path,
        number(match.line),
        el('code', 'database-source-preview', match.preview),
        chip(t(match.confidence), `is-${match.confidence}`)
      ])));
    } else {
      panel.append(stateMessage('No source references found in the selected folder.'));
    }
    if (result.source.limitations.length) panel.append(limitations(result.source.limitations));
  }
  if (result.limitations.length) panel.append(limitations(result.limitations));
  return panel;
}

function renderLocalIncidentHistory(): HTMLElement {
  const section = el('section', 'database-incident-source');
  section.append(el('h4', '', () => t('Local snapshots')));
  if (!incidentHistory) {
    section.append(el('div', 'database-incident-empty', () => t('No incident snapshot loaded yet.')));
    return section;
  }
  if (!incidentHistory.snapshots.length) {
    section.append(el('div', 'database-incident-empty', () => t('No incident snapshots saved for this connection.')));
    return section;
  }

  const selected = incidentHistory.snapshots.find(snapshot => snapshot.id === selectedIncidentSnapshotId) ?? incidentHistory.snapshots[0]!;
  selectedIncidentSnapshotId = selected.id;
  section.append(incidentSnapshotCard(selected));

  const list = el('div', 'database-incident-list');
  list.classList.add('database-incident-timeline');
  for (const snapshot of incidentHistory.snapshots) {
    const row = el('div', 'database-incident-row' + (snapshot.id === selected.id ? ' is-selected' : ''));
    const copy = el('div');
    copy.append(
      el('strong', '', snapshot.database + ' · ' + dateTime(snapshot.capturedAt)),
      el('small', '', t('Active requests') + ': ' + snapshot.summary.activeRequestCount + ' · ' + t('Blocked') + ': ' + snapshot.summary.blockedRequestCount + ' · ' + t('Failed jobs') + ': ' + (snapshot.summary.failedJobCount ?? '—'))
    );
    const actions = el('div', 'database-incident-row-actions');
    const view = button('View details', () => {
      selectedIncidentSnapshotId = snapshot.id;
      renderIncident();
    });
    const remove = button('Delete snapshot', () => void removeIncident(snapshot.id));
    remove.classList.add('database-incident-delete');
    actions.append(view, remove);
    row.append(copy, actions);
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderServerIncidentHistory(): HTMLElement {
  const section = el('section', 'database-incident-source database-server-history');
  section.append(el('h4', '', () => t('Server history')));
  if (serverIncidentHistoryError) {
    section.append(el('div', 'database-incident-empty is-error', serverIncidentHistoryError));
    return section;
  }
  if (!serverIncidentHistoryAttempted) {
    section.append(el('div', 'database-incident-empty', () => t('Load recent captures recorded by the diagnostics worker.')));
    return section;
  }
  if (!serverIncidentHistory) {
    section.append(el('div', 'database-incident-empty', () => t('Server history could not be loaded.')));
    return section;
  }
  if (!serverIncidentHistory.available) {
    section.append(el('div', 'database-incident-empty', () => t('Server diagnostic history is unavailable for this connection.')));
    if (serverIncidentHistory.limitations.length) section.append(limitations(serverIncidentHistory.limitations));
    return section;
  }
  if (!serverIncidentHistory.captures.length) {
    section.append(el('div', 'database-incident-empty', () => t('No server incident captures were found.')));
    return section;
  }

  const captures = el('div', 'database-server-captures');
  serverIncidentHistory.captures.forEach((capture, index) => {
    const item = document.createElement('details');
    item.className = 'database-server-capture';
    item.open = index === 0;
    const summary = document.createElement('summary');
    const copy = el('span', 'database-server-capture-title');
    copy.append(
      el('strong', '', '#' + capture.captureId + ' · ' + dateTime(capture.capturedAt)),
      el('small', '', [capture.serverName, capture.instanceName].filter(Boolean).join(' · ') || serverIncidentHistory!.database)
    );
    const badges = el('span', 'database-incident-reasons');
    badges.append(
      chip(t('Blocked') + ' ' + number(capture.blockingCount), capture.blockingCount ? 'is-danger' : ''),
      chip(t('Long request') + ' ' + number(capture.longRequestCount), capture.longRequestCount ? 'is-medium' : ''),
      chip(t('Open transactions') + ' ' + number(capture.openTransactionCount), capture.openTransactionCount ? 'is-medium' : '')
    );
    summary.append(copy, badges);
    const content = el('div', 'database-server-capture-body');
    content.append(blockingHierarchy(capture.sessions, 'Session evidence'));
    item.append(summary, content);
    captures.append(item);
  });
  section.append(captures);
  if (serverIncidentHistory.limitations.length) section.append(limitations(serverIncidentHistory.limitations));
  return section;
}

function renderIncident(): void {
  if (!body) return;
  const capture = button('Capture now', () => void captureIncident(), true);
  const load = button('Load history', () => void loadIncidentHistory());
  const loadServer = button('Load server history', () => void loadServerIncidentHistory());
  const refreshWatch = button('Refresh watch', () => void loadIncidentWatchStatus());
  const watch = incidentWatchStatus?.watching
    ? button('Stop Watch', () => void stopIncidentWatch())
    : button('Start Watch', () => void startIncidentWatch(), true);
  const clear = button('Clear history', () => void clearIncidentHistory());
  body.replaceChildren(titlebar('Incident Snapshot', 'Capture the database state while the incident is happening.', [load, loadServer, refreshWatch, clear, watch, capture]));
  if (!selectedConnection) {
    body.append(stateMessage('Add a SQL Server connection first.'));
    return;
  }
  body.append(incidentWatchPanel());
  body.append(sourceRootDetails());
  if (incidentCauseTraceResult) body.append(incidentCauseTracePanel(incidentCauseTraceResult));
  const sources = el('div', 'database-incident-sources');
  sources.append(renderLocalIncidentHistory(), renderServerIncidentHistory());
  body.append(sources);
}

async function loadIncidentHistory(): Promise<void> {
  if (!selectedConnection || busy) return;
  busy = true;
  renderBusy();
  const result = await run(api.readDatabaseIncidentHistory(selectedConnection));
  busy = false;
  if (result) {
    incidentHistory = result;
    if (!result.snapshots.some(snapshot => snapshot.id === selectedIncidentSnapshotId)) {
      selectedIncidentSnapshotId = result.snapshots[0]?.id ?? '';
    }
  }
  void loadIncidentWatchStatus();
  renderIncident();
}

async function loadIncidentWatchStatus(): Promise<void> {
  if (!selectedConnection) return;
  const connection = selectedConnection;
  const result = await run(api.readDatabaseIncidentWatchStatus(connection));
  if (connection !== selectedConnection) return;
  if (result) incidentWatchStatus = result;
  if (activeTab === 'incident' && !busy) renderIncident();
}

async function startIncidentWatch(): Promise<void> {
  if (!selectedConnection) return;
  const result = await run(api.startDatabaseIncidentWatch(selectedConnection));
  if (result) {
    incidentWatchStatus = result;
    toast(t('Incident Watch started.'));
  }
  renderIncident();
}

async function stopIncidentWatch(): Promise<void> {
  if (!selectedConnection) return;
  const result = await run(api.stopDatabaseIncidentWatch(selectedConnection));
  if (result) {
    incidentWatchStatus = result;
    toast(t('Incident Watch stopped.'));
  }
  renderIncident();
}

async function traceIncidentCause(session: IncidentSession): Promise<void> {
  if (!selectedConnection || busy) return;
  const sql = session.runningStatement?.trim() || session.sql?.trim() || '';
  if (!sql) return;
  const input = document.getElementById('databaseInvestigatorSourceRoot') as HTMLInputElement | null;
  const sourceRoot = input?.value.trim() ?? '';
  if (!sourceRoot) {
    const advanced = input?.closest('details') as HTMLDetailsElement | null;
    if (advanced) advanced.open = true;
    input?.focus();
    toast(t('Choose an approved source code folder first.'));
    return;
  }
  try { window.localStorage.setItem(SOURCE_ROOT_KEY, sourceRoot); } catch { /* optional preference */ }
  busy = true;
  renderBusy();
  const result = await run(api.traceDatabaseIncidentCause({
    connection: selectedConnection,
    sql,
    sourceRoot
  }));
  busy = false;
  if (result) {
    incidentCauseTraceResult = result;
    incidentCauseSessionId = session.sessionId;
  }
  renderIncident();
}

async function loadServerIncidentHistory(): Promise<void> {
  if (!selectedConnection || busy) return;
  const readServerHistory = (api as DatabaseServerHistoryApi).readDatabaseServerIncidentHistory;
  serverIncidentHistoryAttempted = true;
  serverIncidentHistoryError = null;
  if (!readServerHistory) {
    serverIncidentHistory = null;
    serverIncidentHistoryError = t('Server history is unavailable in this build.');
    renderIncident();
    return;
  }
  serverIncidentHistory = null;
  busy = true;
  renderBusy();
  const result = await run(readServerHistory(selectedConnection));
  busy = false;
  if (result) serverIncidentHistory = result;
  renderIncident();
}

async function captureIncident(): Promise<void> {
  if (!selectedConnection || busy) return;
  busy = true;
  renderBusy();
  const result = await run(api.captureDatabaseIncident(selectedConnection));
  busy = false;
  if (result) {
    incidentHistory = result;
    selectedIncidentSnapshotId = result.snapshots[0]?.id ?? '';
    toast(t('Captured {0}', [dateTime(result.snapshots[0]?.capturedAt ?? null)]));
  }
  renderIncident();
}

async function removeIncident(snapshotId: string): Promise<void> {
  if (!selectedConnection || !window.confirm(t('Delete this incident snapshot?'))) return;
  const result = await run(api.deleteDatabaseIncident(selectedConnection, snapshotId));
  if (result) {
    incidentHistory = result;
    if (selectedIncidentSnapshotId === snapshotId) selectedIncidentSnapshotId = result.snapshots[0]?.id ?? '';
  }
  renderIncident();
}

async function clearIncidentHistory(): Promise<void> {
  if (!selectedConnection || !window.confirm(t('Clear all local incident snapshots for this connection?'))) return;
  const result = await run(api.clearDatabaseIncidentHistory(selectedConnection));
  if (result) {
    incidentHistory = result;
    selectedIncidentSnapshotId = '';
    toast(t('Local incident history cleared.'));
  }
  renderIncident();
}

function columnFlags(match: DatabaseColumnMatch): HTMLElement {
  const flags = el('span', 'database-column-flags');
  if (match.primaryKey) flags.append(chip(t('Primary key'), 'is-high'));
  if (match.indexed) flags.append(chip(t('Indexed')));
  if (match.nullable) flags.append(chip(t('Nullable')));
  if (match.identity) flags.append(chip('IDENTITY'));
  if (match.computed) flags.append(chip('COMPUTED'));
  return flags;
}

function profilePanel(profile: DatabaseColumnProfileResult): HTMLElement {
  const panel = el('section', 'database-investigator-card');
  panel.append(el('h4', '', `${profile.object.schema}.${profile.object.table}.${profile.column.column} · ${profile.column.type}`));
  const grid = el('div', 'database-investigator-grid');
  grid.append(
    metric('Sampled rows', number(profile.sampledRows)),
    metric('NULL rows', number(profile.nullRows), profile.nullRows > 0 ? 'is-warn' : ''),
    metric('Blank rows', profile.blankRows === null ? '—' : number(profile.blankRows), (profile.blankRows ?? 0) > 0 ? 'is-warn' : ''),
    metric('Distinct values', profile.distinctValues === null ? '—' : number(profile.distinctValues)),
    metric('Max data length', profile.maxDataLengthBytes === null ? '—' : `${number(profile.maxDataLengthBytes)} B`)
  );
  panel.append(grid);
  if (profile.examples.length) {
    panel.append(el('h4', '', () => t('Examples')));
    panel.append(table(['Data', 'Rows'], profile.examples.map(example => [example.value ?? 'NULL', number(example.count)])));
  }
  if (profile.limitations.length) panel.append(limitations(profile.limitations));
  return panel;
}

function flowPanel(result: DatabaseFieldConsumersResult): HTMLElement {
  const panel = el('section', 'database-investigator-card');
  panel.append(el('h4', '', () => t('SQL consumers')));
  if (!result.consumers.length) panel.append(stateMessage('No consumers were found in SQL Server metadata.'));
  else panel.append(table(['Consumer', 'Type', 'Confidence', 'Evidence'], result.consumers.map(consumer => [
    `${consumer.schema}.${consumer.name}`,
    consumer.type,
    chip(t(consumer.confidence), `is-${consumer.confidence}`),
    consumer.reason
  ])));
  if (result.limitations.length) panel.append(limitations(result.limitations));
  return panel;
}

function sourceTracePanel(result: DatabaseSourceTraceResult): HTMLElement {
  const panel = el('section', 'database-investigator-card');
  panel.append(el('h4', '', () => t('C#/WinForms source trace')));
  const summary = el('div', 'database-investigator-grid');
  summary.append(
    metric('Files searched', number(result.searchedFiles)),
    metric('Matches', number(result.matches.length)),
    metric('Skipped', number(result.skippedFiles)),
    metric('Duration', durationMs(result.elapsedMs))
  );
  panel.append(summary);
  if (result.matches.length) {
    panel.append(table(['Kind', 'File', 'Line', 'Evidence', 'Confidence'], result.matches.map(match => [
      t(match.kind),
      match.path,
      number(match.line),
      el('code', 'database-source-preview', match.preview),
      chip(t(match.confidence), `is-${match.confidence}`)
    ])));
  } else panel.append(stateMessage('No source references found in the selected folder.'));
  if (result.limitations.length) panel.append(limitations(result.limitations));
  return panel;
}

function sourceRootDetails(): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'database-investigator-advanced';
  const summary = document.createElement('summary');
  summary.textContent = t('Source code folder');
  const wrap = el('div', 'database-investigator-source-root');
  const input = document.createElement('input');
  input.id = 'databaseInvestigatorSourceRoot';
  input.type = 'text';
  input.placeholder = t('Approved source folder path');
  try { input.value = window.localStorage.getItem(SOURCE_ROOT_KEY) ?? ''; } catch { /* renderer may restrict storage */ }
  input.addEventListener('change', () => {
    try { window.localStorage.setItem(SOURCE_ROOT_KEY, input.value.trim()); } catch { /* keep current session usable */ }
  });
  wrap.append(input, el('small', '', () => t('Use a source folder already approved in COS, for example /src-net10-1.0.0.')));
  details.append(summary, wrap);
  return details;
}

function renderColumn(): void {
  if (!body) return;
  body.replaceChildren(titlebar('Field & Flow', 'Find one ERP field, then choose the evidence you need instead of opening separate tools.'));
  const searchRow = el('div', 'database-investigator-search');
  const search = document.createElement('input');
  search.id = 'databaseInvestigatorColumnSearch';
  search.type = 'search';
  search.placeholder = t('Search column name');
  search.autocomplete = 'off';
  search.spellcheck = false;
  const submit = button('Search', () => void searchColumns(search.value), true);
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); void searchColumns(search.value); }
  });
  searchRow.append(search, submit);
  body.append(searchRow);
  if (!selectedConnection) {
    body.append(stateMessage('Add a SQL Server connection first.'));
    return;
  }
  if (!columnMatches.length) {
    body.append(stateMessage('Type a column name such as Ma_YeuCau or Ma_UvTd.'));
  } else {
    const list = el('div', 'database-column-results');
    for (const match of columnMatches) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `database-column-result${selectedColumn?.objectId === match.objectId && selectedColumn.column === match.column ? ' is-selected' : ''}`;
      row.append(el('strong', '', `${match.schema}.${match.table}.${match.column}`), el('code', '', match.type), columnFlags(match));
      row.addEventListener('click', () => {
        selectedColumn = match;
        columnProfile = null;
        flowResult = null;
        sourceTraceResult = null;
        renderColumn();
      });
      list.append(row);
    }
    body.append(list);
  }
  if (selectedColumn) {
    const actions = el('div', 'database-investigator-actions');
    actions.append(actionMenu('Analyze', [
      { label: 'Profile data', action: () => void profileColumn() },
      { label: 'Find SQL consumers', action: () => void loadFlow() },
      { label: 'Trace C#/WinForms', action: () => void traceSource() }
    ]));
    body.append(actions, sourceRootDetails());
  }
  if (columnProfile) body.append(profilePanel(columnProfile));
  if (flowResult) body.append(flowPanel(flowResult));
  if (sourceTraceResult) body.append(sourceTracePanel(sourceTraceResult));
}

async function searchColumns(value: string): Promise<void> {
  const search = value.trim();
  if (!selectedConnection || !search || busy) return;
  busy = true;
  renderBusy();
  const result = await run(api.searchDatabaseColumns(selectedConnection, search));
  busy = false;
  columnMatches = result?.matches ?? [];
  selectedColumn = null;
  columnProfile = null;
  flowResult = null;
  sourceTraceResult = null;
  renderColumn();
  const input = document.getElementById('databaseInvestigatorColumnSearch') as HTMLInputElement | null;
  if (input) input.value = search;
  if (result && !result.matches.length) toast(t('No matching columns.'));
}

async function profileColumn(): Promise<void> {
  if (!selectedConnection || !selectedColumn || busy) return;
  busy = true;
  renderBusy();
  const result = await run(api.profileDatabaseColumn({ connection: selectedConnection, objectId: selectedColumn.objectId, column: selectedColumn.column }));
  busy = false;
  if (result) columnProfile = result;
  renderColumn();
}

async function loadFlow(): Promise<void> {
  if (!selectedConnection || !selectedColumn || busy) return;
  busy = true;
  renderBusy();
  const result = await run(api.readDatabaseFieldConsumers({ connection: selectedConnection, objectId: selectedColumn.objectId, column: selectedColumn.column }));
  busy = false;
  if (result) flowResult = result;
  renderColumn();
}

async function traceSource(): Promise<void> {
  if (!selectedConnection || !selectedColumn || busy) return;
  const input = document.getElementById('databaseInvestigatorSourceRoot') as HTMLInputElement | null;
  const sourceRoot = input?.value.trim() ?? '';
  if (!sourceRoot) {
    const advanced = input?.closest('details') as HTMLDetailsElement | null;
    if (advanced) advanced.open = true;
    input?.focus();
    toast(t('Choose an approved source code folder first.'));
    return;
  }
  try { window.localStorage.setItem(SOURCE_ROOT_KEY, sourceRoot); } catch { /* optional preference */ }
  busy = true;
  renderBusy();
  const result = await run(api.traceDatabaseSource({
    connection: selectedConnection,
    objectId: selectedColumn.objectId,
    column: selectedColumn.column,
    sourceRoot
  }));
  busy = false;
  if (result) sourceTraceResult = result;
  renderColumn();
}

function performanceToolMenu(): HTMLDetailsElement {
  return actionMenu('Performance tool', [
    { label: 'Live now', active: performanceMode === 'live', action: () => { performanceMode = 'live'; renderPerformance(); } },
    { label: 'Query Store history', active: performanceMode === 'query-store', action: () => { performanceMode = 'query-store'; renderPerformance(); } },
    { label: 'Deadlock history', active: performanceMode === 'deadlocks', action: () => { performanceMode = 'deadlocks'; renderPerformance(); } }
  ]);
}

function queryStoreControls(): HTMLElement {
  const controls = el('div', 'database-investigator-inline-controls');
  const hours = document.createElement('select');
  hours.id = 'databaseInvestigatorQueryStoreHours';
  for (const [value, label] of [['1', '1 hour'], ['6', '6 hours'], ['24', '24 hours'], ['168', '7 days']] as const) {
    const option = document.createElement('option'); option.value = value; option.textContent = t(label); hours.append(option);
  }
  hours.value = String(queryStoreResult?.hours ?? 24);
  const sort = document.createElement('select');
  sort.id = 'databaseInvestigatorQueryStoreSort';
  for (const value of ['duration', 'cpu', 'reads', 'executions'] as const) {
    const option = document.createElement('option'); option.value = value; option.textContent = t(`Sort by ${value}`); sort.append(option);
  }
  sort.value = queryStoreResult?.sort ?? 'duration';
  controls.append(hours, sort, button('Run history check', () => void loadQueryStore(), true));
  return controls;
}

function renderQueryStore(): void {
  if (!body) return;
  body.replaceChildren(titlebar('Query Store history', 'Look back at expensive queries after the customer slowdown has already ended.', [performanceToolMenu()]), queryStoreControls());
  if (!selectedConnection) { body.append(stateMessage('Add a SQL Server connection first.')); return; }
  if (!queryStoreResult) { body.append(stateMessage('Run a check to see evidence here.')); return; }
  const result = queryStoreResult;
  const status = el('div', 'database-investigator-grid');
  status.append(
    metric('State', result.actualState ?? '—', !result.available ? 'is-warn' : ''),
    metric('Period', `${result.hours}h`),
    metric('Queries', number(result.queries.length)),
    metric('Storage', result.currentStorageMb === null ? '—' : `${decimal(result.currentStorageMb)} / ${decimal(result.maxStorageMb ?? 0)} MB`)
  );
  body.append(status);
  if (result.queries.length) body.append(table(['Query', 'Executions', 'Avg duration', 'Avg CPU', 'Reads', 'Plans', 'Last run', 'SQL'], result.queries.map(item => [
    String(item.queryId), number(item.executionCount), durationMs(item.avgDurationMs), durationMs(item.avgCpuMs), decimal(item.avgLogicalReads), number(item.planCount), dateTime(item.lastExecutionAt), el('span', 'is-sql', item.sql ?? '—')
  ])));
  else body.append(stateMessage(result.available ? 'No Query Store rows were found in this period.' : 'Query Store history is unavailable for this database.'));
  if (result.limitations.length) body.append(limitations(result.limitations));
}

function renderDeadlocks(): void {
  if (!body) return;
  body.replaceChildren(titlebar('Deadlock history', 'Read recent deadlocks retained by SQL Server system_health Extended Events.', [performanceToolMenu(), button('Load deadlocks', () => void loadDeadlocks(), true)]));
  if (!selectedConnection) { body.append(stateMessage('Add a SQL Server connection first.')); return; }
  if (!deadlockResult) { body.append(stateMessage('Run a check to see evidence here.')); return; }
  if (!deadlockResult.available) {
    body.append(stateMessage('Deadlock history is unavailable for this connection.'));
    if (deadlockResult.limitations.length) body.append(limitations(deadlockResult.limitations));
    return;
  }
  if (!deadlockResult.events.length) body.append(stateMessage('No deadlocks are currently retained in system_health.'));
  for (const event of deadlockResult.events) {
    const card = el('section', 'database-investigator-card database-deadlock-card');
    card.append(el('h4', '', `${dateTime(event.happenedAt)} · ${t('Victim')}: ${event.victimProcessId ?? '—'}`));
    if (event.objects.length) card.append(el('p', '', `${t('Objects')}: ${event.objects.join(', ')}`));
    if (event.processes.length) card.append(table(['Session', 'Victim', 'Host', 'Application', 'Wait', 'SQL'], event.processes.map(process => [
      process.sessionId === null ? '—' : String(process.sessionId), process.victim ? t('Yes') : t('No'), process.host ?? '—', process.application ?? '—', process.waitResource ?? '—', el('span', 'is-sql', process.statement ?? '—')
    ])));
    body.append(card);
  }
  if (deadlockResult.limitations.length) body.append(limitations(deadlockResult.limitations));
}

function renderPerformance(): void {
  if (!body) return;
  if (performanceMode === 'query-store') { renderQueryStore(); return; }
  if (performanceMode === 'deadlocks') { renderDeadlocks(); return; }
  body.replaceChildren(titlebar('Live Performance', 'Read active requests, waits, blocking and cached query hotspots without changing the server.', [
    performanceToolMenu(), button('Run live check', () => void loadPerformance(), true)
  ]));
  if (!selectedConnection) {
    body.append(stateMessage('Add a SQL Server connection first.'));
    return;
  }
  if (!performanceResult) {
    body.append(stateMessage('No live performance capture yet.'));
    return;
  }
  const grid = el('div', 'database-investigator-grid');
  grid.append(
    metric('Requests', number(performanceResult.requests.length)),
    metric('Blocked', number(performanceResult.blockedRequestCount), performanceResult.blockedRequestCount ? 'is-bad' : ''),
    metric('Root blockers', performanceResult.rootBlockerSessionIds.length ? performanceResult.rootBlockerSessionIds.join(', ') : '—', performanceResult.rootBlockerSessionIds.length ? 'is-bad' : ''),
    metric('Duration', durationMs(performanceResult.elapsedMs))
  );
  body.append(grid);
  if (performanceResult.requests.length) {
    body.append(table(['Session', 'Status', 'Duration', 'Wait', 'Reads', 'Writes', 'SQL'], performanceResult.requests.map(request => {
      const sql = el('span', 'is-sql', request.sql ?? '—');
      return [
        String(request.sessionId),
        `${request.status}${request.blockingSessionId ? ` · blocked by ${request.blockingSessionId}` : ''}`,
        durationMs(request.elapsedMs),
        request.waitType ? `${request.waitType} · ${durationMs(request.waitMs)}` : '—',
        number(request.logicalReads),
        number(request.writes),
        sql
      ];
    })));
  } else {
    body.append(stateMessage('No active user requests were captured.'));
  }
  if (performanceResult.hotspots.length) {
    const card = el('section', 'database-investigator-card');
    card.append(el('h4', '', () => t('Cached query hotspots')));
    card.append(table(['Executions', 'Avg duration', 'Total CPU', 'Reads', 'SQL'], performanceResult.hotspots.map(hotspot => [
      number(hotspot.executionCount),
      durationMs(hotspot.avgElapsedMs),
      durationMs(hotspot.totalCpuMs),
      number(hotspot.totalLogicalReads),
      el('span', 'is-sql', hotspot.sql ?? '—')
    ])));
    body.append(card);
  }
  if (performanceResult.limitations.length) body.append(limitations(performanceResult.limitations));
}

async function loadPerformance(): Promise<void> {
  if (!selectedConnection || busy) return;
  busy = true;
  renderBusy();
  const result = await run(api.readDatabaseLivePerformance(selectedConnection));
  busy = false;
  if (result) performanceResult = result;
  renderPerformance();
}

async function loadQueryStore(): Promise<void> {
  if (!selectedConnection || busy) return;
  const hoursNode = document.getElementById('databaseInvestigatorQueryStoreHours') as HTMLSelectElement | null;
  const sortNode = document.getElementById('databaseInvestigatorQueryStoreSort') as HTMLSelectElement | null;
  const hours = Number(hoursNode?.value ?? 24) as 1 | 6 | 24 | 168;
  const sort = (sortNode?.value ?? 'duration') as 'duration' | 'cpu' | 'reads' | 'executions';
  busy = true; renderBusy();
  const result = await run(api.readDatabaseQueryStore({ connection: selectedConnection, hours, sort }));
  busy = false;
  if (result) queryStoreResult = result;
  renderPerformance();
}

async function loadDeadlocks(): Promise<void> {
  if (!selectedConnection || busy) return;
  busy = true; renderBusy();
  const result = await run(api.readDatabaseDeadlocks(selectedConnection));
  busy = false;
  if (result) deadlockResult = result;
  renderPerformance();
}

function schemaControls(): HTMLElement {
  const controls = el('div', 'database-schema-controls');
  const baselineLabel = document.createElement('label');
  baselineLabel.append(el('span', '', () => t('Baseline connection')));
  const baseline = document.createElement('select');
  baseline.id = 'databaseInvestigatorSchemaBaseline';
  populateConnectionSelect(baseline, schemaBaselineConnection);
  baselineLabel.append(baseline);
  const arrow = el('span', 'database-schema-arrow', '→');
  const currentLabel = document.createElement('label');
  currentLabel.append(el('span', '', () => t('Current connection')));
  const current = document.createElement('select');
  current.id = 'databaseInvestigatorSchemaCurrent';
  populateConnectionSelect(current, schemaCurrentConnection || selectedConnection);
  if (baseline.value === current.value) {
    const alternate = [...baseline.options].find(option => option.value !== current.value);
    if (alternate) baseline.value = alternate.value;
  }
  schemaBaselineConnection = baseline.value;
  schemaCurrentConnection = current.value;
  baseline.addEventListener('change', () => { schemaBaselineConnection = baseline.value; });
  current.addEventListener('change', () => { schemaCurrentConnection = current.value; });
  currentLabel.append(current);
  controls.append(baselineLabel, arrow, currentLabel, button('Compare databases', () => void compareSchema(), true));
  return controls;
}

function compareScopeMenu(): HTMLDetailsElement {
  return actionMenu('Show differences', [
    { label: 'All differences', active: compareScope === 'all', action: () => { compareScope = 'all'; renderSchema(); } },
    { label: 'Table & index structure', active: compareScope === 'structure', action: () => { compareScope = 'structure'; renderSchema(); } },
    { label: 'Procedure & view code', active: compareScope === 'sql-code', action: () => { compareScope = 'sql-code'; renderSchema(); } }
  ]);
}

function isSqlCodeDifference(kind: DatabaseSchemaCompareResult['differences'][number]['kind']): boolean {
  return kind.startsWith('procedure-') || kind.startsWith('view-');
}

function schemaDifferenceLabel(kind: DatabaseSchemaCompareResult['differences'][number]['kind']): string {
  const labels: Partial<Record<DatabaseSchemaCompareResult['differences'][number]['kind'], string>> = {
    'procedure-added': 'Procedure added',
    'procedure-removed': 'Procedure removed',
    'procedure-changed': 'Procedure changed',
    'view-added': 'View added',
    'view-removed': 'View removed',
    'view-changed': 'View changed'
  };
  return labels[kind] ?? kind;
}

function codeDifferenceCards(differences: DatabaseSchemaCompareResult['differences']): HTMLElement {
  const list = el('div', 'database-code-diff-list');
  for (const diff of differences) {
    const card = el('section', 'database-code-diff-card');
    const head = el('div', 'database-code-diff-head');
    const tone = diff.kind.endsWith('-added') ? 'is-high' : diff.kind.endsWith('-changed') ? 'is-medium' : 'is-low';
    const badges = el('div', 'database-code-diff-badges');
    badges.append(chip(t(schemaDifferenceLabel(diff.kind)), tone), chip(t(diff.confidence), `is-${diff.confidence}`));
    head.append(el('strong', '', diff.object), badges);
    const versions = el('div', 'database-code-diff-versions');
    const baseline = el('div', 'database-code-diff-version');
    baseline.append(el('span', '', () => t('Baseline')), el('pre', 'database-compare-snippet', diff.baseline ?? '—'));
    const current = el('div', 'database-code-diff-version');
    current.append(el('span', '', () => t('Current')), el('pre', 'database-compare-snippet', diff.current ?? '—'));
    versions.append(baseline, current);
    card.append(head);
    if (diff.detail) card.append(el('p', 'database-code-diff-detail', diff.detail));
    card.append(versions);
    list.append(card);
  }
  return list;
}

function renderSchema(): void {
  if (!body) return;
  const codeOnly = compareScope === 'sql-code';
  body.replaceChildren(titlebar(
    codeOnly ? 'Procedure & View Compare' : 'Compare databases',
    codeOnly ? 'Compare stored procedure and view definitions between two SQL Server connections.' : 'Compare table structure and stored procedure/view code between two SQL Server connections.',
    [compareScopeMenu()]
  ), schemaControls());
  if ((settings?.settings.connections.length ?? 0) < 2) {
    body.append(stateMessage('Choose two different connections.'));
    return;
  }
  if (!schemaResult) {
    body.append(stateMessage('Run a check to see evidence here.'));
    return;
  }
  const summary = schemaResult.summary;
  const structureAdded = summary.tablesAdded + summary.columnsAdded + summary.indexesAdded;
  const structureRemoved = summary.tablesRemoved + summary.columnsRemoved + summary.indexesRemoved;
  const structureChanged = summary.columnsChanged + summary.indexesChanged;
  const codeAdded = summary.proceduresAdded + summary.viewsAdded;
  const codeRemoved = summary.proceduresRemoved + summary.viewsRemoved;
  const codeChanged = summary.proceduresChanged + summary.viewsChanged;
  const includeStructure = compareScope !== 'sql-code';
  const includeCode = compareScope !== 'structure';
  const grid = el('div', 'database-investigator-grid');
  grid.append(
    metric('Added', number((includeStructure ? structureAdded : 0) + (includeCode ? codeAdded : 0))),
    metric('Removed', number((includeStructure ? structureRemoved : 0) + (includeCode ? codeRemoved : 0)), structureRemoved + codeRemoved > 0 ? 'is-warn' : ''),
    metric('Changed', number((includeStructure ? structureChanged : 0) + (includeCode ? codeChanged : 0)), structureChanged + codeChanged > 0 ? 'is-warn' : ''),
    metric('Duration', durationMs(schemaResult.elapsedMs))
  );
  body.append(grid);
  const visibleDifferences = schemaResult.differences.filter(diff => compareScope === 'all' || (compareScope === 'sql-code' ? isSqlCodeDifference(diff.kind) : !isSqlCodeDifference(diff.kind)));
  const structureDifferences = visibleDifferences.filter(diff => !isSqlCodeDifference(diff.kind));
  const codeDifferences = visibleDifferences.filter(diff => isSqlCodeDifference(diff.kind));
  if (structureDifferences.length) {
    body.append(table(['Difference', 'Object', 'Baseline', 'Current', 'Confidence'], structureDifferences.map(diff => [
      diff.kind,
      diff.object,
      el('pre', 'database-compare-snippet', diff.baseline ?? '—'),
      el('pre', 'database-compare-snippet', diff.current ?? '—'),
      chip(t(diff.confidence), `is-${diff.confidence}`)
    ])));
  }
  if (codeDifferences.length) body.append(codeDifferenceCards(codeDifferences));
  if (!visibleDifferences.length) {
    body.append(stateMessage('No structural differences found in the captured scope.'));
  }
  if (schemaResult.limitations.length) body.append(limitations(schemaResult.limitations));
}

async function compareSchema(): Promise<void> {
  if (busy) return;
  const baseline = document.getElementById('databaseInvestigatorSchemaBaseline') as HTMLSelectElement | null;
  const current = document.getElementById('databaseInvestigatorSchemaCurrent') as HTMLSelectElement | null;
  if (!baseline?.value || !current?.value || baseline.value === current.value) {
    toast(t('Choose two different connections.'));
    return;
  }
  schemaBaselineConnection = baseline.value;
  schemaCurrentConnection = current.value;
  busy = true;
  renderBusy();
  const result = await run(api.compareDatabaseSchemas({ baselineConnection: baseline.value, currentConnection: current.value }));
  busy = false;
  if (result) schemaResult = result;
  renderSchema();
}

function jobOutcome(job: DatabaseAgentJobSummary): HTMLElement {
  const tone = job.lastOutcome === 'failed' ? 'is-low' : job.lastOutcome === 'succeeded' ? 'is-high' : 'is-medium';
  return chip(t(job.lastOutcome), tone);
}

function renderJobs(): void {
  if (!body) return;
  body.replaceChildren(titlebar('Jobs', 'Read SQL Server Agent job status and recent outcome.', [button('Load jobs', () => void loadJobs(), true)]));
  if (!selectedConnection) {
    body.append(stateMessage('Add a SQL Server connection first.'));
    return;
  }
  if (!jobsResult) {
    body.append(stateMessage('No SQL Agent capture yet.'));
    return;
  }
  if (!jobsResult.available) {
    body.append(stateMessage('SQL Server Agent information is unavailable for this connection.'));
    if (jobsResult.limitations.length) body.append(limitations(jobsResult.limitations));
    return;
  }
  const grid = el('div', 'database-investigator-grid');
  grid.append(
    metric('Jobs', number(jobsResult.jobs.length)),
    metric('Failed', number(jobsResult.failedJobCount), jobsResult.failedJobCount ? 'is-bad' : ''),
    metric('Disabled', number(jobsResult.disabledJobCount), jobsResult.disabledJobCount ? 'is-warn' : ''),
    metric('Duration', durationMs(jobsResult.elapsedMs))
  );
  body.append(grid);
  body.append(table(['Jobs', 'Status', 'Outcome', 'Last run', 'Next run', 'Message'], jobsResult.jobs.map(job => [
    job.name,
    t(job.enabled ? 'Enabled' : 'Disabled'),
    jobOutcome(job),
    dateTime(job.lastRunAt),
    dateTime(job.nextRunAt),
    job.lastMessage ?? '—'
  ])));
  if (jobsResult.limitations.length) body.append(limitations(jobsResult.limitations));
}

async function loadJobs(): Promise<void> {
  if (!selectedConnection || busy) return;
  busy = true;
  renderBusy();
  const result = await run(api.readDatabaseJobs(selectedConnection));
  busy = false;
  if (result) jobsResult = result;
  renderJobs();
}

function renderBusy(): void {
  if (!body) return;
  body.replaceChildren(stateMessage('Working…'));
}

function renderBody(): void {
  if (!body) return;
  if (busy) { renderBusy(); return; }
  if (activeTab === 'incident') renderIncident();
  else if (activeTab === 'column') renderColumn();
  else if (activeTab === 'performance') renderPerformance();
  else if (activeTab === 'schema') renderSchema();
  else renderJobs();
}

function paintConnection(): void {
  if (!root) return;
  const select = root.querySelector<HTMLSelectElement>('#databaseInvestigatorConnection');
  if (!select) return;
  populateConnectionSelect(select, selectedConnection);
  selectedConnection = select.value;
  select.disabled = (settings?.settings.connections.length ?? 0) === 0;
}

function build(mount: HTMLElement): void {
  const shell = el('section', 'database-investigator');
  shell.id = 'databaseInvestigator';
  const head = el('div', 'database-investigator-head');
  const copy = el('div');
  copy.append(
    el('h2', '', () => t('Database Investigator')),
    el('p', '', () => t('Choose the symptom first. Each investigator runs bounded, read-only checks and keeps measured evidence separate from assumptions.'))
  );
  const connection = document.createElement('select');
  connection.id = 'databaseInvestigatorConnection';
  connection.setAttribute('aria-label', t('Investigation connection'));
  connection.addEventListener('change', () => {
    if (connection.value === selectedConnection) return;
    selectedConnection = connection.value;
    resetConnectionScopedEvidence();
    renderBody();
    if (activeTab === 'incident' && selectedConnection) void loadIncidentWatchStatus();
  });
  head.append(copy, connection);

  const tabs = el('div', 'database-investigator-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const item of TABS) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'database-investigator-tab';
    tab.dataset.investigatorTab = item.id;
    tab.setAttribute('role', 'tab');
    tab.textContent = t(item.label);
    tab.addEventListener('click', () => selectTab(item.id));
    tabs.append(tab);
  }
  const more = investigatorToolsMenu();
  more.classList.add('database-investigator-more');
  tabs.append(more);

  body = el('div', 'database-investigator-body');
  shell.append(head, tabs, body);
  mount.append(shell);
  root = shell;
  renderTabs();
  renderBody();
}

export function initDatabaseInvestigator(mount: HTMLElement): void {
  if (root) return;
  build(mount);
  window.addEventListener('cos:database-language-changed', () => {
    renderTabs();
    if (root) root.querySelector<HTMLSelectElement>('#databaseInvestigatorConnection')?.setAttribute('aria-label', t('Investigation connection'));
    renderBody();
  });
}

export function setDatabaseInvestigatorState(next: DatabaseSettingsState): void {
  settings = next;
  const profiles = next.settings.connections;
  if (!profiles.some(profile => profile.id === selectedConnection)) {
    selectedConnection = next.settings.defaultConnectionId ?? profiles[0]?.id ?? '';
    resetConnectionScopedEvidence();
  }
  paintConnection();
  renderBody();
  if (activeTab === 'incident' && selectedConnection && incidentWatchStatus?.connection !== selectedConnection) {
    void loadIncidentWatchStatus();
  }
}
