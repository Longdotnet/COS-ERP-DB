import type { AppApi } from '../../preload/index.js';
import type {
  DatabaseGrowthDiagnosticsResult,
  DatabaseGrowthFinding,
  DatabaseGrowthHistoryResult,
  DatabaseGrowthSnapshot,
  DatabaseGrowthSnapshotInput,
  DatabaseGrowthTableSummary,
  DatabaseSettingsState
} from '../../shared/database.js';
import { el, run, toast } from '../../renderer/dom.js';
import { t } from './i18n.js';
import { openDatabaseExplorerObject } from './database-explorer.js';
import './database-growth-dashboard.css';

const api = (window as Window & { api: AppApi }).api;

let root: HTMLElement | null = null;
let selectedConnection = '';
let generation = 0;
const cache = new Map<string, DatabaseGrowthDiagnosticsResult>();
const historyCache = new Map<string, DatabaseGrowthHistoryResult>();

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing growth dashboard element #${id}`);
  return node as T;
}

function formatMb(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10_240 ? 1 : 2)} GB`;
  if (value >= 100) return `${value.toFixed(0)} MB`;
  return `${value.toFixed(1)} MB`;
}

function formatRows(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function metric(label: string, value: string, hint: string, tone = ''): HTMLElement {
  const card = el('article', `database-growth-metric${tone ? ` ${tone}` : ''}`);
  card.append(
    el('span', 'database-growth-metric-label', () => t(label)),
    el('strong', '', value),
    el('small', '', () => t(hint))
  );
  return card;
}

function sectionHead(title: string, detail = ''): HTMLElement {
  const head = el('div', 'database-growth-section-head');
  head.append(el('h3', '', () => t(title)));
  if (detail) head.append(el('span', '', () => t(detail)));
  return head;
}

function findingCard(finding: DatabaseGrowthFinding): HTMLElement {
  const card = el('article', `database-growth-finding is-${finding.severity}`);
  const top = el('div', 'database-growth-finding-head');
  top.append(
    el('span', `database-growth-severity is-${finding.severity}`, finding.severity.toUpperCase()),
    el('strong', '', finding.title)
  );
  card.append(top, el('p', '', finding.detail), el('small', '', finding.nextAction));
  if (finding.object) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn database-growth-open-object';
    open.textContent = t('Open object');
    open.addEventListener('click', () => openDatabaseExplorerObject(selectedConnection, {
      ...finding.object!,
      modifiedAt: null
    }));
    card.append(open);
  }
  return card;
}

function largestTableRow(table: DatabaseGrowthTableSummary): HTMLTableRowElement {
  const row = document.createElement('tr');
  const name = document.createElement('td');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'database-growth-table-link';
  open.textContent = `${table.schema}.${table.name}`;
  open.title = t('Open table in Object Explorer');
  open.addEventListener('click', () => openDatabaseExplorerObject(selectedConnection, {
    objectId: table.objectId,
    schema: table.schema,
    name: table.name,
    type: 'table',
    modifiedAt: null
  }));
  name.append(open);
  for (const node of [
    name,
    el('td', '', formatRows(table.rows)),
    el('td', '', formatMb(table.reservedMb)),
    el('td', '', formatMb(table.usedMb)),
    el('td', '', formatMb(table.indexMb))
  ]) row.append(node);
  return row;
}

function allocationBar(result: DatabaseGrowthDiagnosticsResult): HTMLElement {
  const total = Math.max(result.summary.totalMb, 0.01);
  const dataPercent = Math.max(0, Math.min(100, result.summary.dataMb / total * 100));
  const logPercent = Math.max(0, 100 - dataPercent);
  const block = el('div', 'database-growth-allocation');
  const bar = el('div', 'database-growth-allocation-bar');
  const data = el('span', 'is-data');
  data.style.width = `${dataPercent}%`;
  const log = el('span', 'is-log');
  log.style.width = `${logPercent}%`;
  bar.append(data, log);
  const legend = el('div', 'database-growth-allocation-legend');
  legend.append(
    el('span', '', `Data ${dataPercent.toFixed(0)}%`),
    el('span', '', `Log ${logPercent.toFixed(0)}%`)
  );
  block.append(bar, legend);
  return block;
}

function snapshotInput(result: DatabaseGrowthDiagnosticsResult): DatabaseGrowthSnapshotInput {
  return {
    database: result.database,
    capturedAt: result.capturedAt,
    summary: result.summary,
    largestTables: result.largestTables.slice(0, 25)
  };
}

function oldestBaseline(): DatabaseGrowthSnapshot | undefined {
  const history = historyCache.get(selectedConnection);
  return history?.snapshots.at(-1);
}

function signedSize(value: number): string {
  if (Math.abs(value) < 0.005) return '0 MB';
  return `${value > 0 ? '+' : '−'}${formatMb(Math.abs(value))}`;
}

function historyPanel(result: DatabaseGrowthDiagnosticsResult): HTMLElement {
  const panel = el('section', 'database-growth-panel database-growth-history');
  const history = historyCache.get(selectedConnection);
  const snapshots = history?.snapshots ?? [];
  const baseline = snapshots.at(-1);
  const head = sectionHead('Saved growth history', snapshots.length ? `${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}` : 'No baseline yet');
  panel.append(head);
  if (!baseline) {
    panel.append(el('p', 'database-growth-baseline-note', () => t('Save this investigation as a local snapshot. A later investigation can then prove how total, data and log allocation changed over time.')));
    return panel;
  }

  const baselineAt = new Date(baseline.capturedAt);
  if (baseline.capturedAt === result.capturedAt) {
    panel.append(el('p', 'database-growth-baseline-note', `Baseline saved at ${baselineAt.toLocaleString()}. Run the investigation again at a later date to measure growth from this point.`));
    return panel;
  }

  const grid = el('div', 'database-growth-history-grid');
  grid.append(
    metric('Total change', signedSize(result.summary.totalMb - baseline.summary.totalMb), `since ${baselineAt.toLocaleDateString()}`),
    metric('Data change', signedSize(result.summary.dataMb - baseline.summary.dataMb), `${signedSize(result.summary.dataUsedMb - baseline.summary.dataUsedMb)} used`),
    metric('Log change', signedSize(result.summary.logMb - baseline.summary.logMb), `${signedSize(result.summary.logUsedMb - baseline.summary.logUsedMb)} used`)
  );
  panel.append(grid);

  const baselineTables = new Map(baseline.largestTables.map(table => [`${table.schema}\u0000${table.name}`, table]));
  const comparable = result.largestTables
    .map(table => ({ table, before: baselineTables.get(`${table.schema}\u0000${table.name}`) }))
    .filter((entry): entry is { table: DatabaseGrowthTableSummary; before: DatabaseGrowthTableSummary } => Boolean(entry.before))
    .map(({ table, before }) => ({
      name: `${table.schema}.${table.name}`,
      reservedDelta: table.reservedMb - before.reservedMb,
      rowDelta: table.rows - before.rows
    }))
    .sort((left, right) => Math.abs(right.reservedDelta) - Math.abs(left.reservedDelta))
    .slice(0, 5);

  if (comparable.length) {
    const table = document.createElement('table');
    table.className = 'database-growth-table database-growth-history-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const text of ['Comparable table', 'Storage change', 'Row change']) headRow.append(el('th', '', () => t(text)));
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    for (const entry of comparable) {
      const row = document.createElement('tr');
      row.append(
        el('td', '', entry.name),
        el('td', '', signedSize(entry.reservedDelta)),
        el('td', '', `${entry.rowDelta > 0 ? '+' : ''}${Math.round(entry.rowDelta).toLocaleString('en-US')}`)
      );
      tbody.append(row);
    }
    table.append(thead, tbody);
    const scroll = el('div', 'database-growth-table-scroll');
    scroll.append(table);
    panel.append(scroll, el('p', 'database-growth-baseline-note', () => t('Table deltas are shown only for tables present in both bounded top-table snapshots. Missing tables are not assumed to have been zero.')));
  }
  return panel;
}

function render(result: DatabaseGrowthDiagnosticsResult): void {
  if (!root) return;
  const body = byId('databaseGrowthBody');
  const summary = el('div', 'database-growth-metrics');
  summary.append(
    metric('Total allocated', formatMb(result.summary.totalMb), `${result.summary.tableCount} user tables`),
    metric('Data files', formatMb(result.summary.dataMb), `${formatMb(result.summary.dataUsedMb)} used`, 'is-data'),
    metric('Transaction log', formatMb(result.summary.logMb), result.log.available ? `${formatMb(result.summary.logUsedMb)} used` : 'Usage details unavailable', 'is-log'),
    metric('Log used', result.log.available ? `${result.summary.logUsedPercent.toFixed(1)}%` : 'Unavailable', result.log.stateAvailable ? result.log.reuseWait : 'Needs additional SQL metadata permission', result.log.available && result.summary.logUsedPercent >= 90 ? 'is-danger' : '')
  );

  const overview = el('section', 'database-growth-panel database-growth-overview');
  const overviewHead = el('div', 'database-growth-section-head');
  overviewHead.append(el('h3', '', () => t('Storage allocation')), el('span', 'database-growth-snapshot-badge', () => t('Current snapshot')));
  const baseline = el('p', 'database-growth-baseline-note', () => t('This explains the current storage shape. Historical growth still needs an older backup or a dated baseline for comparison.'));
  overview.append(overviewHead, allocationBar(result), baseline);

  const findings = el('section', 'database-growth-panel database-growth-findings');
  const findingsHead = sectionHead('Ranked findings');
  findingsHead.append(el('span', '', `${result.findings.length}`));
  findings.append(findingsHead);
  const findingList = el('div', 'database-growth-finding-list');
  for (const finding of result.findings) findingList.append(findingCard(finding));
  findings.append(findingList);

  const logHealth = el('section', 'database-growth-panel database-growth-log-health');
  logHealth.append(sectionHead('Log health'));
  const logGrid = el('dl', 'database-growth-kv');
  const entries: Array<[string, string]> = [
    ['Recovery model', result.log.stateAvailable ? result.log.recoveryModel : 'Unavailable'],
    ['Reuse wait', result.log.stateAvailable ? result.log.reuseWait : 'Unavailable'],
    ['Allocated', formatMb(result.log.totalMb)],
    ['Used', result.log.available ? `${formatMb(result.log.usedMb)} · ${result.log.usedPercent.toFixed(1)}%` : 'Unavailable'],
    ['Free', result.log.available ? formatMb(result.log.freeMb) : 'Unavailable']
  ];
  if (result.log.sinceLastBackupMb !== null) entries.push(['Since last log backup', formatMb(result.log.sinceLastBackupMb)]);
  for (const [key, value] of entries) logGrid.append(el('dt', '', () => t(key)), el('dd', '', value));
  logHealth.append(logGrid);

  const tables = el('section', 'database-growth-panel database-growth-tables');
  tables.append(sectionHead('Largest tables', 'Click a table to drill down'));
  const tableScroll = el('div', 'database-growth-table-scroll');
  const table = document.createElement('table');
  table.className = 'database-growth-table';
  const thead = document.createElement('thead');
  const header = document.createElement('tr');
  for (const text of ['Table', 'Rows', 'Reserved', 'Used', 'Indexes']) header.append(el('th', '', () => t(text)));
  thead.append(header);
  const tbody = document.createElement('tbody');
  for (const item of result.largestTables.slice(0, 10)) tbody.append(largestTableRow(item));
  table.append(thead, tbody);
  tableScroll.append(table);
  tables.append(tableScroll);
  if (!result.tableStorageAvailable) tables.append(el('p', 'database-growth-baseline-note', () => t('Per-table storage is unavailable for this SQL login.')));

  const actions = el('section', 'database-growth-panel database-growth-actions');
  actions.append(sectionHead('Next actions'));
  const actionList = document.createElement('ol');
  for (const action of result.nextActions) actionList.append(el('li', '', action));
  actions.append(actionList);

  if (result.limitations.length) {
    const limits = el('section', 'database-growth-panel database-growth-limitations');
    limits.append(sectionHead('Limited by SQL permissions'));
    const list = document.createElement('ul');
    for (const limitation of result.limitations) list.append(el('li', '', limitation));
    limits.append(list);
    actions.append(limits);
  }

  const lower = el('div', 'database-growth-lower-grid');
  lower.append(findings, logHealth);
  body.replaceChildren(summary, overview, historyPanel(result), lower, tables, actions);
  byId('databaseGrowthMeta').textContent = `${result.database} · ${result.elapsedMs} ms · ${new Date(result.capturedAt).toLocaleString()}`;
  byId<HTMLButtonElement>('databaseGrowthExplain').disabled = false;
  byId<HTMLButtonElement>('databaseGrowthSaveSnapshot').disabled = false;
}

function renderEmpty(message: string, isError = false): void {
  if (!root) return;
  const state = el('div', `database-growth-state${isError ? ' is-error' : ''}`);
  state.append(el('strong', '', () => t(isError ? 'Investigation unavailable' : 'Database investigation')), el('p', '', () => t(message)));
  byId('databaseGrowthBody').replaceChildren(state);
  byId('databaseGrowthMeta').textContent = '';
  byId<HTMLButtonElement>('databaseGrowthExplain').disabled = true;
  byId<HTMLButtonElement>('databaseGrowthSaveSnapshot').disabled = true;
}

function aiPrompt(result: DatabaseGrowthDiagnosticsResult): string {
  const findings = result.findings.slice(0, 8).map(finding =>
    `- [${finding.severity.toUpperCase()}] ${finding.title}: ${finding.detail} Next: ${finding.nextAction}`
  ).join('\n');
  const largest = result.largestTables.slice(0, 5).map(table =>
    `- ${table.schema}.${table.name}: ${formatRows(table.rows)} rows, ${formatMb(table.reservedMb)} reserved, ${formatMb(table.indexMb)} indexes`
  ).join('\n');
  const limits = result.limitations.length ? result.limitations.map(item => `- ${item}`).join('\n') : '- none';
  const baseline = oldestBaseline();
  const historicalEvidence = baseline && baseline.capturedAt !== result.capturedAt
    ? [
        `Saved baseline: ${baseline.capturedAt}.`,
        `Measured allocation changes since baseline: total ${signedSize(result.summary.totalMb - baseline.summary.totalMb)}, data ${signedSize(result.summary.dataMb - baseline.summary.dataMb)}, log ${signedSize(result.summary.logMb - baseline.summary.logMb)}, data-used ${signedSize(result.summary.dataUsedMb - baseline.summary.dataUsedMb)}.`
      ].join('\n')
    : 'No older saved baseline is available. Do not infer historical growth from the current snapshot.';
  return [
    `Explain this Database Growth Investigation for connection "${selectedConnection}" / database "${result.database}" in Vietnamese for an ERP developer.`,
    'Use only the evidence below. Clearly separate measured evidence from hypotheses. Do not claim historical growth unless a dated baseline or older backup exists.',
    'Give: (1) what is happening in plain language, (2) likely causes ranked by confidence, (3) the next 3 checks/actions, and (4) what cannot yet be concluded.',
    '',
    `Snapshot: total ${formatMb(result.summary.totalMb)}, data ${formatMb(result.summary.dataMb)} (${formatMb(result.summary.dataUsedMb)} used), log ${formatMb(result.summary.logMb)} (${result.log.available ? `${formatMb(result.log.usedMb)} / ${result.log.usedPercent.toFixed(1)}% used` : 'usage unavailable'}).`,
    `Log state: recovery=${result.log.stateAvailable ? result.log.recoveryModel : 'unavailable'}, reuse_wait=${result.log.stateAvailable ? result.log.reuseWait : 'unavailable'}.`,
    '',
    'Ranked findings:',
    findings || '- none',
    '',
    'Largest tables:',
    largest || '- unavailable',
    '',
    'Diagnostic limitations:',
    limits,
    '',
    'Historical evidence:',
    historicalEvidence
  ].join('\n');
}

function renderReady(): void {
  const cached = cache.get(selectedConnection);
  if (cached) {
    render(cached);
    return;
  }
  renderEmpty('Run an investigation when you need storage diagnostics. Object Explorer stays idle until you start it.');
}

async function load(force = false): Promise<void> {
  if (!root || !selectedConnection) {
    renderEmpty('Add a SQL Server connection to run growth diagnostics.');
    return;
  }
  const cached = cache.get(selectedConnection);
  if (!force && cached) {
    render(cached);
    return;
  }
  const token = ++generation;
  const button = byId<HTMLButtonElement>('databaseGrowthRefresh');
  button.disabled = true;
  renderEmpty('Reading database files, log health and largest tables…');
  const result = await run(api.readDatabaseGrowthDiagnostics(selectedConnection));
  if (token !== generation) return;
  button.disabled = false;
  if (!result) {
    renderEmpty('Could not read growth diagnostics for this connection.', true);
    return;
  }
  cache.set(selectedConnection, result);
  const history = await run(api.readDatabaseGrowthHistory(selectedConnection));
  if (token !== generation) return;
  if (history) historyCache.set(selectedConnection, history);
  render(result);
}

function build(mount: HTMLElement): void {
  const shell = el('section', 'database-growth-dashboard');
  shell.id = 'databaseGrowthDashboard';
  const head = el('div', 'database-growth-head');
  const copy = el('div');
  copy.append(
    el('span', 'database-growth-eyebrow', () => t('Database health')),
    el('h2', '', () => t('Growth Investigation')),
    el('p', '', () => t('Triage database growth from storage → tables → object details without starting from raw SQL.'))
  );
  const controls = el('div', 'database-growth-controls');
  const connection = document.createElement('select');
  connection.id = 'databaseGrowthConnection';
  connection.setAttribute('aria-label', t('Investigation connection'));
  const refresh = document.createElement('button');
  refresh.id = 'databaseGrowthRefresh';
  refresh.type = 'button';
  refresh.className = 'btn';
  refresh.textContent = t('Run investigation');
  const explain = document.createElement('button');
  explain.id = 'databaseGrowthExplain';
  explain.type = 'button';
  explain.className = 'btn is-primary';
  explain.textContent = t('Explain with AI');
  explain.disabled = true;
  const saveSnapshot = document.createElement('button');
  saveSnapshot.id = 'databaseGrowthSaveSnapshot';
  saveSnapshot.type = 'button';
  saveSnapshot.className = 'btn';
  saveSnapshot.textContent = t('Save snapshot');
  saveSnapshot.disabled = true;
  controls.append(connection, refresh, saveSnapshot, explain);
  head.append(copy, controls);
  const meta = el('p', 'database-growth-meta');
  meta.id = 'databaseGrowthMeta';
  const body = el('div', 'database-growth-body');
  body.id = 'databaseGrowthBody';
  shell.append(head, meta, body);
  mount.append(shell);
  root = shell;

  connection.addEventListener('change', () => {
    generation += 1;
    selectedConnection = connection.value;
    renderReady();
  });
  refresh.addEventListener('click', () => void load(true));
  saveSnapshot.addEventListener('click', async () => {
    const result = cache.get(selectedConnection);
    if (!result) return;
    saveSnapshot.disabled = true;
    const history = await run(api.saveDatabaseGrowthSnapshot(selectedConnection, snapshotInput(result)));
    saveSnapshot.disabled = false;
    if (!history) return;
    historyCache.set(selectedConnection, history);
    render(result);
    toast(t('Growth snapshot saved locally'));
  });
  explain.addEventListener('click', () => {
    const result = cache.get(selectedConnection);
    if (!result) return;
    window.dispatchEvent(new window.CustomEvent('cos:database-open-chat', {
      detail: { suggestedText: aiPrompt(result), autoSend: true }
    }));
  });
  renderEmpty('Add a SQL Server connection to run growth diagnostics.');
}

export function initDatabaseGrowthDashboard(mount: HTMLElement): void {
  if (root) return;
  build(mount);
}

export function setDatabaseGrowthDashboardState(next: DatabaseSettingsState): void {
  if (!root) return;
  const select = byId<HTMLSelectElement>('databaseGrowthConnection');
  const previous = selectedConnection;
  select.replaceChildren(...next.settings.connections.map(profile => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} · ${profile.database}`;
    return option;
  }));
  const available = next.settings.connections.some(profile => profile.id === previous);
  const nextConnection = available ? previous : next.settings.defaultConnectionId ?? next.settings.connections[0]?.id ?? '';
  const changed = nextConnection !== selectedConnection;
  selectedConnection = nextConnection;
  select.value = selectedConnection;
  select.disabled = selectedConnection === '';
  byId<HTMLButtonElement>('databaseGrowthRefresh').disabled = selectedConnection === '';
  if (!selectedConnection) {
    generation += 1;
    renderEmpty('Add a SQL Server connection to run growth diagnostics.');
    return;
  }
  if (changed) generation += 1;
  renderReady();
}
