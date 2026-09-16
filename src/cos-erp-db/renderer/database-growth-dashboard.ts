import type { AppApi } from '../../preload/index.js';
import type {
  DatabaseGrowthDiagnosticsResult,
  DatabaseGrowthFinding,
  DatabaseGrowthHistoryResult,
  DatabaseGrowthCapture,
  DatabaseGrowthCompareSource,
  DatabaseGrowthComparisonResult,
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
let comparisonGeneration = 0;
let comparisonSourcesGeneration = 0;
let latestSettings: DatabaseSettingsState | null = null;
const cache = new Map<string, DatabaseGrowthDiagnosticsResult>();
const historyCache = new Map<string, DatabaseGrowthHistoryResult>();
let activeComparison: DatabaseGrowthComparisonResult | null = null;

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

function snapshotInput(capture: DatabaseGrowthCapture): DatabaseGrowthSnapshotInput {
  return capture;
}

function snapshotTables(snapshot: DatabaseGrowthSnapshot): DatabaseGrowthTableSummary[] {
  return snapshot.tables ?? snapshot.largestTables ?? [];
}

function oldestBaseline(): DatabaseGrowthSnapshot | undefined {
  const history = historyCache.get(selectedConnection);
  return history?.snapshots.at(-1);
}

function signedSize(value: number): string {
  if (Math.abs(value) < 0.005) return '0 MB';
  return `${value > 0 ? '+' : '−'}${formatMb(Math.abs(value))}`;
}

function signedRows(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toLocaleString('en-US')}`;
}

function encodeCompareSource(source: DatabaseGrowthCompareSource): string {
  return JSON.stringify(source);
}

function decodeCompareSource(value: string): DatabaseGrowthCompareSource | null {
  try {
    const parsed = JSON.parse(value) as Partial<DatabaseGrowthCompareSource>;
    if (parsed.type === 'live' && typeof parsed.connection === 'string') {
      return { type: 'live', connection: parsed.connection };
    }
    if (parsed.type === 'snapshot' && typeof parsed.connection === 'string' && typeof parsed.snapshotId === 'string') {
      return { type: 'snapshot', connection: parsed.connection, snapshotId: parsed.snapshotId };
    }
  } catch {
    // Select values are app-owned; an invalid value is treated as unavailable rather than guessed.
  }
  return null;
}

function compareSourceDescription(source: DatabaseGrowthComparisonResult['baseline'] | DatabaseGrowthComparisonResult['current']): string {
  return source.source === 'snapshot'
    ? `saved snapshot captured ${new Date(source.capturedAt).toLocaleString()}`
    : `live database captured ${new Date(source.capturedAt).toLocaleString()}`;
}

function comparisonAiPrompt(result: DatabaseGrowthComparisonResult): string {
  const baselineDate = result.baseline.asOf
    ? `The user declared the baseline database represents ${result.baseline.asOf}.`
    : result.baseline.source === 'snapshot'
      ? `The baseline is a saved measurement captured at ${result.baseline.capturedAt}. If that snapshot came from a restored older backup, its capture timestamp alone does not prove the backup's business as-of date.`
      : `No historical as-of date was supplied for the live baseline. Do not infer the age of the baseline from its database or connection name.`;
  const tables = result.tableDeltas.slice(0, 12).map(table =>
    `- ${table.schema}.${table.name} [${table.state}]: used ${signedSize(table.usedDeltaMb)}, reserved ${signedSize(table.reservedDeltaMb)}, rows ${signedRows(table.rowDelta)}, indexes ${signedSize(table.indexDeltaMb)}`
  ).join('\n');
  const files = result.fileDeltas.slice(0, 8).map(file =>
    `- ${file.type} ${file.name} [${file.state}]: allocated ${signedSize(file.sizeDeltaMb)}${file.usedDeltaMb === null ? '' : `, used ${signedSize(file.usedDeltaMb)}`}`
  ).join('\n');
  const schemas = result.schemaDeltas.slice(0, 12).map(delta =>
    `- ${delta.schema}.${delta.name}: columns ${delta.baselineColumnCount} → ${delta.currentColumnCount}${delta.columnChanged ? ' (changed)' : ''}, indexes ${delta.baselineIndexCount} → ${delta.currentIndexCount}${delta.indexChanged ? ' (changed)' : ''}`
  ).join('\n');
  const limitations = result.limitations.length ? result.limitations.map(item => `- ${item}`).join('\n') : '- none';
  return [
    `Explain this SQL Server Database Growth Compare in Vietnamese for an ERP developer.`,
    `Baseline: ${result.baseline.source} source, connection "${result.baseline.connection}" / database "${result.baseline.database}", captured ${result.baseline.capturedAt}.`,
    `Current: ${result.current.source} source, connection "${result.current.connection}" / database "${result.current.database}", captured ${result.current.capturedAt}.`,
    baselineDate,
    'Use only measured evidence below. Separate measured facts from hypotheses. Do not claim a historical cause merely because two database states differ.',
    'Give: (1) what changed in plain language, (2) where the measured growth is concentrated, (3) likely causes ranked by confidence, (4) the next 3 checks/actions, and (5) what cannot yet be concluded.',
    '',
    'Measured summary:',
    `- total allocated: ${signedSize(result.summary.totalAllocatedDeltaMb)}`,
    `- data allocated: ${signedSize(result.summary.dataAllocatedDeltaMb)}`,
    `- data actually used: ${signedSize(result.summary.dataUsedDeltaMb)}`,
    `- log allocated: ${signedSize(result.summary.logAllocatedDeltaMb)}`,
    `- log currently used: ${signedSize(result.summary.logUsedDeltaMb)}`,
    `- measured table-used delta: ${signedSize(result.summary.tableUsedDeltaMb)}`,
    `- unattributed data-used delta: ${signedSize(result.summary.unattributedDataUsedDeltaMb)}`,
    `- attribution coverage: ${result.summary.attributionPercent === null ? 'not applicable' : `${result.summary.attributionPercent.toFixed(1)}%`}`,
    `- user-table count delta: ${signedRows(result.summary.tableCountDelta)}`,
    `- tables added: ${result.summary.addedTableCount}`,
    `- tables removed: ${result.summary.removedTableCount}`,
    `- matching tables with column/index drift: ${result.summary.schemaChangedTableCount}`,
    '',
    `Largest object differences (${result.returnedTableDifferenceCount} shown of ${result.totalTableDifferenceCount}):`,
    tables || '- none',
    '',
    'File differences:',
    files || '- none',
    '',
    `Column/index fingerprint differences (${result.returnedSchemaDifferenceCount} shown of ${result.totalSchemaDifferenceCount}):`,
    schemas || '- none',
    '',
    'Limitations:',
    limitations
  ].join('\n');
}

function renderComparison(result: DatabaseGrowthComparisonResult): void {
  if (!root) return;
  activeComparison = result;
  const body = byId('databaseGrowthCompareBody');
  body.hidden = false;

  const summary = el('section', 'database-growth-panel database-growth-compare-summary');
  const dateDetail = result.baseline.asOf
    ? `Baseline as of ${result.baseline.asOf}`
    : `${compareSourceDescription(result.baseline)} → ${compareSourceDescription(result.current)}`;
  summary.append(sectionHead('Database comparison', `${result.baseline.database} → ${result.current.database}`));
  const metrics = el('div', 'database-growth-metrics');
  metrics.append(
    metric('Total allocation change', signedSize(result.summary.totalAllocatedDeltaMb), dateDetail),
    metric('Data allocation change', signedSize(result.summary.dataAllocatedDeltaMb), `${signedSize(result.summary.dataUsedDeltaMb)} actually used`, 'is-data'),
    metric('Log allocation change', signedSize(result.summary.logAllocatedDeltaMb), `${signedSize(result.summary.logUsedDeltaMb)} currently used`, 'is-log'),
    metric('Measured attribution', result.summary.attributionPercent === null ? 'N/A' : `${result.summary.attributionPercent.toFixed(1)}%`, `${signedSize(result.summary.unattributedDataUsedDeltaMb)} data-used delta remains unattributed`)
  );
  summary.append(
    metrics,
    el('p', 'database-growth-baseline-note', () => t('Allocated file growth and actually used data are shown separately so preallocated free space is not mistaken for ERP row growth.')),
    el('p', 'database-growth-baseline-note', `Tables: +${result.summary.addedTableCount.toLocaleString('en-US')} added · −${result.summary.removedTableCount.toLocaleString('en-US')} removed · ${result.summary.schemaChangedTableCount.toLocaleString('en-US')} matching table${result.summary.schemaChangedTableCount === 1 ? '' : 's'} changed columns or indexes.`)
  );

  const objects = el('section', 'database-growth-panel database-growth-compare-objects');
  objects.append(sectionHead('Largest object changes', `${result.returnedTableDifferenceCount} of ${result.totalTableDifferenceCount}`));
  if (result.tableDeltas.length === 0) {
    objects.append(el('p', 'database-growth-baseline-note', () => t('No table storage or row-count differences were measured in the captured table set.')));
  } else {
    const table = document.createElement('table');
    table.className = 'database-growth-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const text of ['Object', 'State', 'Used Δ', 'Reserved Δ', 'Rows Δ', 'Indexes Δ']) headRow.append(el('th', '', text));
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    for (const item of result.tableDeltas.slice(0, 25)) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      if (result.current.source === 'live' && item.currentObjectId !== null) {
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'database-growth-table-link';
        open.textContent = `${item.schema}.${item.name}`;
        open.addEventListener('click', () => openDatabaseExplorerObject(result.current.connection, {
          objectId: item.currentObjectId!,
          schema: item.schema,
          name: item.name,
          type: 'table',
          modifiedAt: null
        }));
        name.append(open);
      } else {
        name.textContent = `${item.schema}.${item.name}`;
      }
      row.append(
        name,
        el('td', '', item.state),
        el('td', '', signedSize(item.usedDeltaMb)),
        el('td', '', signedSize(item.reservedDeltaMb)),
        el('td', '', signedRows(item.rowDelta)),
        el('td', '', signedSize(item.indexDeltaMb))
      );
      tbody.append(row);
    }
    table.append(thead, tbody);
    const scroll = el('div', 'database-growth-table-scroll');
    scroll.append(table);
    objects.append(scroll);
    if (result.omittedTableDifferenceCount > 0) {
      objects.append(el('p', 'database-growth-baseline-note', `${result.omittedTableDifferenceCount.toLocaleString('en-US')} additional object differences were omitted from this summary. Attribution above was calculated before this display limit.`));
    }
  }

  const files = el('section', 'database-growth-panel database-growth-compare-files');
  files.append(sectionHead('Database file changes'));
  if (result.fileDeltas.length === 0) {
    files.append(el('p', 'database-growth-baseline-note', () => t('No database-file allocation differences were measured.')));
  } else {
    const list = document.createElement('table');
    list.className = 'database-growth-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const text of ['File', 'Type', 'State', 'Allocated Δ', 'Used Δ']) headRow.append(el('th', '', text));
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    for (const item of result.fileDeltas) {
      const row = document.createElement('tr');
      row.append(
        el('td', '', item.name),
        el('td', '', item.type),
        el('td', '', item.state),
        el('td', '', signedSize(item.sizeDeltaMb)),
        el('td', '', item.usedDeltaMb === null ? 'Unavailable' : signedSize(item.usedDeltaMb))
      );
      tbody.append(row);
    }
    list.append(thead, tbody);
    const scroll = el('div', 'database-growth-table-scroll');
    scroll.append(list);
    files.append(scroll);
  }

  const schema = el('section', 'database-growth-panel database-growth-compare-schema');
  schema.append(sectionHead('Schema & index drift', `${result.returnedSchemaDifferenceCount} of ${result.totalSchemaDifferenceCount}`));
  if (result.schemaDeltas.length === 0) {
    schema.append(el('p', 'database-growth-baseline-note', () => t('No column or index fingerprint differences were measured for tables present in both captured sources.')));
  } else {
    const table = document.createElement('table');
    table.className = 'database-growth-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const text of ['Object', 'Columns', 'Indexes']) headRow.append(el('th', '', text));
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    for (const item of result.schemaDeltas.slice(0, 25)) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      if (result.current.source === 'live' && item.currentObjectId !== null) {
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'database-growth-table-link';
        open.textContent = `${item.schema}.${item.name}`;
        open.addEventListener('click', () => openDatabaseExplorerObject(result.current.connection, {
          objectId: item.currentObjectId!,
          schema: item.schema,
          name: item.name,
          type: 'table',
          modifiedAt: null
        }));
        name.append(open);
      } else {
        name.textContent = `${item.schema}.${item.name}`;
      }
      row.append(
        name,
        el('td', '', `${item.baselineColumnCount} → ${item.currentColumnCount}${item.columnChanged ? ' · changed' : ''}`),
        el('td', '', `${item.baselineIndexCount} → ${item.currentIndexCount}${item.indexChanged ? ' · changed' : ''}`)
      );
      tbody.append(row);
    }
    table.append(thead, tbody);
    const scroll = el('div', 'database-growth-table-scroll');
    scroll.append(table);
    schema.append(scroll);
    if (result.omittedSchemaDifferenceCount > 0) {
      schema.append(el('p', 'database-growth-baseline-note', `${result.omittedSchemaDifferenceCount.toLocaleString('en-US')} additional schema/index differences were omitted from this summary.`));
    }
  }

  const panels: HTMLElement[] = [summary, objects, schema, files];
  if (result.limitations.length) {
    const limits = el('section', 'database-growth-panel database-growth-limitations');
    limits.append(sectionHead('Comparison limitations'));
    const list = document.createElement('ul');
    for (const limitation of result.limitations) list.append(el('li', '', limitation));
    limits.append(list);
    panels.push(limits);
  }
  body.replaceChildren(...panels);
  byId<HTMLButtonElement>('databaseGrowthCompareExplain').disabled = false;
}

function renderComparisonState(message: string, isError = false): void {
  const body = byId('databaseGrowthCompareBody');
  body.hidden = false;
  const state = el('div', `database-growth-state${isError ? ' is-error' : ''}`);
  state.append(el('strong', '', () => t(isError ? 'Comparison unavailable' : 'Database comparison')), el('p', '', () => t(message)));
  body.replaceChildren(state);
  activeComparison = null;
  byId<HTMLButtonElement>('databaseGrowthCompareExplain').disabled = true;
}

async function refreshComparisonSources(next: DatabaseSettingsState): Promise<void> {
  if (!root) return;
  const token = ++comparisonSourcesGeneration;
  const baselineSelect = byId<HTMLSelectElement>('databaseGrowthCompareBaseline');
  const currentSelect = byId<HTMLSelectElement>('databaseGrowthCompareCurrent');
  const runCompare = byId<HTMLButtonElement>('databaseGrowthCompareRun');
  const previousBaseline = baselineSelect.value;
  const previousCurrent = currentSelect.value;
  baselineSelect.disabled = true;
  currentSelect.disabled = true;
  runCompare.disabled = true;

  const histories = await Promise.all(next.settings.connections.map(async profile => {
    const reply = await api.readDatabaseGrowthHistory(profile.id);
    const history = reply.ok ? reply.data : { connection: profile.id, snapshots: [] };
    if (reply.ok) historyCache.set(profile.id, history);
    return { profile, history };
  }));
  if (!root || token !== comparisonSourcesGeneration) return;

  const choices: Array<{ source: DatabaseGrowthCompareSource; label: string; capturedAt?: string }> = [];
  for (const { profile, history } of histories) {
    choices.push({
      source: { type: 'live', connection: profile.id },
      label: `Live · ${profile.name} · ${profile.database}`
    });
    for (const snapshot of history.snapshots) {
      choices.push({
        source: { type: 'snapshot', connection: profile.id, snapshotId: snapshot.id },
        label: `Snapshot · ${profile.name} · ${new Date(snapshot.capturedAt).toLocaleString()} · ${snapshot.database}`,
        capturedAt: snapshot.capturedAt
      });
    }
  }

  const makeOptions = () => choices.map(choice => {
    const option = document.createElement('option');
    option.value = encodeCompareSource(choice.source);
    option.textContent = choice.label;
    return option;
  });
  baselineSelect.replaceChildren(...makeOptions());
  currentSelect.replaceChildren(...makeOptions());
  const values = new Set(choices.map(choice => encodeCompareSource(choice.source)));

  const defaultCurrent = encodeCompareSource({
    type: 'live',
    connection: selectedConnection || next.settings.defaultConnectionId || next.settings.connections[0]?.id || ''
  });
  const currentValue = values.has(previousCurrent) ? previousCurrent : values.has(defaultCurrent) ? defaultCurrent : choices[0] ? encodeCompareSource(choices[0].source) : '';
  const currentSource = decodeCompareSource(currentValue);

  let baselineValue = values.has(previousBaseline) && previousBaseline !== currentValue ? previousBaseline : '';
  if (!baselineValue && currentSource) {
    const sameConnectionSnapshots = choices
      .filter(choice => choice.source.type === 'snapshot' && choice.source.connection === currentSource.connection)
      .sort((left, right) => (left.capturedAt ?? '').localeCompare(right.capturedAt ?? ''));
    const oldest = sameConnectionSnapshots.find(choice => encodeCompareSource(choice.source) !== currentValue);
    if (oldest) baselineValue = encodeCompareSource(oldest.source);
  }
  if (!baselineValue) {
    const alternate = choices.find(choice => encodeCompareSource(choice.source) !== currentValue);
    baselineValue = alternate ? encodeCompareSource(alternate.source) : '';
  }

  currentSelect.value = currentValue;
  baselineSelect.value = baselineValue;
  const canCompare = Boolean(baselineValue && currentValue && baselineValue !== currentValue);
  baselineSelect.disabled = choices.length < 2;
  currentSelect.disabled = choices.length < 2;
  runCompare.disabled = !canCompare;
  if (!canCompare) {
    activeComparison = null;
    byId<HTMLButtonElement>('databaseGrowthCompareExplain').disabled = true;
  }
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

  const baselineTables = new Map(snapshotTables(baseline).map(table => [`${table.schema}\u0000${table.name}`, table]));
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

  const compareBar = el('section', 'database-growth-compare-bar');
  const compareCopy = el('div', 'database-growth-compare-copy');
  compareCopy.append(
    el('strong', '', () => t('Compare databases')),
    el('span', '', () => t('Compare live databases or saved snapshots to explain storage, table, column and index changes over time.'))
  );
  const compareControls = el('div', 'database-growth-compare-controls');
  const baselineConnection = document.createElement('select');
  baselineConnection.id = 'databaseGrowthCompareBaseline';
  baselineConnection.setAttribute('aria-label', t('Baseline database connection'));
  const baselineAsOf = document.createElement('input');
  baselineAsOf.id = 'databaseGrowthCompareBaselineDate';
  baselineAsOf.type = 'date';
  baselineAsOf.title = t('Optional date represented by the restored baseline backup');
  baselineAsOf.setAttribute('aria-label', t('Baseline as-of date'));
  const currentConnection = document.createElement('select');
  currentConnection.id = 'databaseGrowthCompareCurrent';
  currentConnection.setAttribute('aria-label', t('Current database connection'));
  const runCompare = document.createElement('button');
  runCompare.id = 'databaseGrowthCompareRun';
  runCompare.type = 'button';
  runCompare.className = 'btn';
  runCompare.textContent = t('Compare');
  const explainCompare = document.createElement('button');
  explainCompare.id = 'databaseGrowthCompareExplain';
  explainCompare.type = 'button';
  explainCompare.className = 'btn is-primary';
  explainCompare.textContent = t('Explain comparison with AI');
  explainCompare.disabled = true;
  compareControls.append(baselineConnection, baselineAsOf, currentConnection, runCompare, explainCompare);
  compareBar.append(compareCopy, compareControls);

  const compareBody = el('div', 'database-growth-body database-growth-compare-body');
  compareBody.id = 'databaseGrowthCompareBody';
  compareBody.hidden = true;
  const meta = el('p', 'database-growth-meta');
  meta.id = 'databaseGrowthMeta';
  const body = el('div', 'database-growth-body');
  body.id = 'databaseGrowthBody';
  shell.append(head, compareBar, compareBody, meta, body);
  mount.append(shell);
  root = shell;

  connection.addEventListener('change', () => {
    generation += 1;
    selectedConnection = connection.value;
    renderReady();
  });
  refresh.addEventListener('click', () => void load(true));
  for (const control of [baselineConnection, currentConnection, baselineAsOf]) {
    control.addEventListener('change', () => {
      comparisonGeneration += 1;
      activeComparison = null;
      explainCompare.disabled = true;
      runCompare.disabled = baselineConnection.value === ''
        || currentConnection.value === ''
        || baselineConnection.value === currentConnection.value;
    });
  }
  runCompare.addEventListener('click', async () => {
    const baselineSource = decodeCompareSource(baselineConnection.value);
    const currentSource = decodeCompareSource(currentConnection.value);
    if (!baselineSource || !currentSource || baselineConnection.value === currentConnection.value) return;
    const token = ++comparisonGeneration;
    runCompare.disabled = true;
    renderComparisonState('Loading both database states and attributing storage differences…');
    const result = await run(api.compareDatabaseGrowth({
      baseline: baselineSource,
      current: currentSource,
      ...(baselineAsOf.value ? { baselineAsOf: baselineAsOf.value } : {})
    }));
    if (token !== comparisonGeneration) return;
    runCompare.disabled = false;
    if (!result) {
      renderComparisonState('Could not compare these database connections.', true);
      return;
    }
    renderComparison(result);
  });
  explainCompare.addEventListener('click', () => {
    if (!activeComparison) return;
    window.dispatchEvent(new window.CustomEvent('cos:database-open-chat', {
      detail: { suggestedText: comparisonAiPrompt(activeComparison), autoSend: true }
    }));
  });
  saveSnapshot.addEventListener('click', async () => {
    const result = cache.get(selectedConnection);
    if (!result) return;
    saveSnapshot.disabled = true;
    const capture = await run(api.readDatabaseGrowthCapture(selectedConnection));
    if (!capture) {
      saveSnapshot.disabled = false;
      return;
    }
    const history = await run(api.saveDatabaseGrowthSnapshot(selectedConnection, snapshotInput(capture)));
    saveSnapshot.disabled = false;
    if (!history) return;
    historyCache.set(selectedConnection, history);
    render(result);
    if (latestSettings) void refreshComparisonSources(latestSettings);
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
  latestSettings = next;
  const select = byId<HTMLSelectElement>('databaseGrowthConnection');
  const previous = selectedConnection;
  const makeConnectionOptions = () => next.settings.connections.map(profile => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} · ${profile.database}`;
    return option;
  });
  select.replaceChildren(...makeConnectionOptions());
  const available = next.settings.connections.some(profile => profile.id === previous);
  const nextConnection = available ? previous : next.settings.defaultConnectionId ?? next.settings.connections[0]?.id ?? '';
  const changed = nextConnection !== selectedConnection;
  selectedConnection = nextConnection;
  select.value = selectedConnection;
  select.disabled = selectedConnection === '';
  byId<HTMLButtonElement>('databaseGrowthRefresh').disabled = selectedConnection === '';
  void refreshComparisonSources(next);
  if (!selectedConnection) {
    generation += 1;
    renderEmpty('Add a SQL Server connection to run growth diagnostics.');
    return;
  }
  if (changed) generation += 1;
  renderReady();
}
