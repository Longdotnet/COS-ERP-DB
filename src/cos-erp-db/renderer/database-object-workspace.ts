import type { AppApi } from '../../preload/index.js';
import type {
  DatabaseAccessMode,
  DatabaseObjectDetailsResult,
  DatabaseObjectDetailSection,
  DatabaseObjectSummary
} from '../../shared/database.js';
import { el, run } from '../../renderer/dom.js';
import { clearDatabaseTableSharedRows, closeDatabaseTableGrid, openDatabaseTableGrid } from './database-grid.js';
import { publishDatabaseWorkspaceContext } from './database-workspace-context.js';
import { t } from './i18n.js';
import { copyDatabaseText } from './database-clipboard.js';

const api = (window as Window & { api: AppApi }).api;

type WorkspaceTab = 'data' | DatabaseObjectDetailSection;

interface WorkspaceState {
  generation: number;
  mount: HTMLElement;
  connection: string;
  object: DatabaseObjectSummary;
  accessMode: DatabaseAccessMode;
  cache: Map<DatabaseObjectDetailSection, DatabaseObjectDetailsResult>;
  activeTab: WorkspaceTab;
}

let active: WorkspaceState | null = null;

function label(tab: WorkspaceTab): string {
  if (tab === 'data') return t('Data');
  if (tab === 'columns') return t('Columns');
  if (tab === 'keys_indexes') return t('Keys & Indexes');
  if (tab === 'ddl') return t('DDL');
  return t('Dependencies');
}

function tabsFor(object: DatabaseObjectSummary): WorkspaceTab[] {
  if (object.type === 'table') return ['data', 'columns', 'keys_indexes', 'ddl', 'dependencies'];
  if (object.type === 'view') return ['columns', 'ddl', 'dependencies'];
  return ['ddl', 'dependencies'];
}

function initialTab(object: DatabaseObjectSummary): WorkspaceTab {
  if (object.type === 'table') return 'data';
  if (object.type === 'view') return 'columns';
  return 'ddl';
}

function tsv(rows: readonly (readonly string[])[]): string {
  return rows.map(row => row.map(value => value.replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ')).join('\t')).join('\r\n');
}

function detailTable(headers: string[], rows: string[][]): HTMLElement {
  const block = el('div', 'database-detail-table-block');
  const actions = el('div', 'database-detail-actions');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn database-detail-copy';
  copy.textContent = t('Copy table');
  copy.addEventListener('click', () => void copyDatabaseText(tsv([headers, ...rows])));
  actions.append(copy);
  const scroll = el('div', 'database-detail-table-scroll');
  const table = document.createElement('table');
  table.className = 'database-detail-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const header of headers) {
    const th = document.createElement('th');
    th.textContent = header;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const values of rows) {
    const row = document.createElement('tr');
    for (const value of values) {
      const td = document.createElement('td');
      td.textContent = value;
      td.title = value;
      td.tabIndex = 0;
      row.append(td);
    }
    body.append(row);
  }
  table.append(head, body);
  scroll.append(table);
  block.append(actions, scroll);
  return block;
}

function empty(text: string): HTMLElement {
  return el('div', 'database-detail-empty', () => t(text));
}

function renderColumns(content: HTMLElement, details: DatabaseObjectDetailsResult): void {
  const columns = details.columns ?? [];
  if (!columns.length) {
    content.replaceChildren(empty('No columns found.'));
    return;
  }
  content.replaceChildren(detailTable(
    [t('#'), t('Column'), t('Type'), t('Nullable'), t('Attributes'), t('Default / expression')],
    columns.map(column => [
      String(column.ordinal),
      column.name,
      column.type,
      column.nullable ? t('Yes') : t('No'),
      [column.identity ? 'IDENTITY' : '', column.computed ? 'COMPUTED' : ''].filter(Boolean).join(', ') || '—',
      column.computedDefinition ?? column.defaultDefinition ?? '—'
    ])
  ));
}

function renderKeysIndexes(content: HTMLElement, details: DatabaseObjectDetailsResult): void {
  const indexes = details.indexes ?? [];
  const foreignKeys = details.foreignKeys ?? [];
  const fragment = document.createDocumentFragment();
  const indexHeading = el('h4', 'database-detail-heading', () => t('Indexes'));
  fragment.append(indexHeading);
  if (indexes.length) {
    fragment.append(detailTable(
      [t('Name'), t('Type'), t('Flags'), t('Columns')],
      indexes.map(index => [
        index.name,
        index.type,
        [index.primaryKey ? 'PRIMARY KEY' : '', index.unique ? 'UNIQUE' : '', index.uniqueConstraint ? 'CONSTRAINT' : '', index.disabled ? 'DISABLED' : ''].filter(Boolean).join(', ') || '—',
        index.columns.map(column => `${column.name}${column.included ? ' [INCLUDE]' : column.descending ? ' DESC' : ' ASC'}`).join(', ')
      ])
    ));
  } else {
    fragment.append(empty('No indexes found.'));
  }
  const fkHeading = el('h4', 'database-detail-heading', () => t('Foreign keys'));
  fragment.append(fkHeading);
  if (foreignKeys.length) {
    fragment.append(detailTable(
      [t('Name'), t('Columns'), t('References'), t('Actions')],
      foreignKeys.map(key => [
        key.name,
        key.columns.join(', '),
        `${key.referencedSchema}.${key.referencedTable} (${key.referencedColumns.join(', ')})`,
        `UPDATE ${key.updateAction} · DELETE ${key.deleteAction}`
      ])
    ));
  } else {
    fragment.append(empty('No foreign keys found.'));
  }
  content.replaceChildren(fragment);
}

function renderDdl(content: HTMLElement, details: DatabaseObjectDetailsResult): void {
  const ddl = details.ddl;
  if (!ddl?.text) {
    content.replaceChildren(empty('Definition is unavailable.'));
    return;
  }
  const top = el('div', 'database-ddl-meta');
  const badge = el('span', `database-ddl-kind${ddl.complete ? '' : ' is-warn'}`);
  badge.textContent = ddl.kind === 'generated-table' ? t('Generated structural script') : ddl.kind === 'source' ? t('Stored source') : t('DDL');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn database-ddl-copy';
  copy.textContent = t('Copy');
  copy.addEventListener('click', () => void copyDatabaseText(ddl.text));
  const wrap = document.createElement('button');
  wrap.type = 'button';
  wrap.className = 'btn database-ddl-wrap';
  wrap.textContent = t('Wrap');
  wrap.setAttribute('aria-pressed', 'false');
  const controls = el('div', 'database-ddl-actions');
  controls.append(wrap, copy);
  top.append(badge, controls);
  const pre = document.createElement('pre');
  pre.className = 'database-ddl-source';
  const code = document.createElement('code');
  code.textContent = ddl.text;
  pre.append(code);
  wrap.addEventListener('click', () => {
    const wrapped = pre.classList.toggle('is-wrapped');
    wrap.setAttribute('aria-pressed', String(wrapped));
    wrap.textContent = t(wrapped ? 'No wrap' : 'Wrap');
  });
  const nodes: Node[] = [top];
  if (ddl.note) nodes.push(el('p', 'database-detail-warning', ddl.note));
  if (ddl.truncated) nodes.push(el('p', 'database-detail-warning', () => t('Definition was truncated to the safe display limit.')));
  nodes.push(pre);
  content.replaceChildren(...nodes);
}

function dependencyName(dependency: NonNullable<DatabaseObjectDetailsResult['outboundDependencies']>[number]): string {
  const local = [dependency.schema, dependency.name].filter(Boolean).join('.');
  return [dependency.server, dependency.database, local].filter(Boolean).join(' · ');
}

function dependencySection(title: string, dependencies: NonNullable<DatabaseObjectDetailsResult['outboundDependencies']>): HTMLElement {
  const section = el('section', 'database-dependency-section');
  section.append(el('h4', 'database-detail-heading', () => t(title)));
  if (!dependencies.length) {
    section.append(empty('No dependencies found.'));
    return section;
  }
  const list = el('div', 'database-dependency-list');
  for (const dependency of dependencies) {
    const row = el('div', 'database-dependency-row');
    const name = dependencyName(dependency);
    const value = el('strong', '', name);
    value.title = name;
    row.append(value, el('span', '', dependency.type ?? t('Unresolved')));
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderDependencies(content: HTMLElement, details: DatabaseObjectDetailsResult): void {
  content.replaceChildren(
    dependencySection('References', details.outboundDependencies ?? []),
    dependencySection('Referenced by', details.inboundDependencies ?? [])
  );
  if (details.truncated) content.prepend(el('p', 'database-detail-warning', () => t('Dependency results reached the safe display limit.')));
}

function renderDetails(content: HTMLElement, details: DatabaseObjectDetailsResult): void {
  content.classList.remove('database-grid-host', 'is-loading');
  if (details.section === 'columns') renderColumns(content, details);
  else if (details.section === 'keys_indexes') renderKeysIndexes(content, details);
  else if (details.section === 'ddl') renderDdl(content, details);
  else renderDependencies(content, details);
}

async function activate(state: WorkspaceState, tab: WorkspaceTab): Promise<void> {
  state.activeTab = tab;
  const content = state.mount.querySelector<HTMLElement>('.database-object-workspace-content')!;
  state.mount.querySelectorAll<HTMLButtonElement>('.database-object-tab').forEach(button => {
    const selected = button.dataset.tab === tab;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  closeDatabaseTableGrid();
  content.classList.remove('database-grid-host', 'is-loading');
  publishDatabaseWorkspaceContext({
    connection: state.connection,
    object: {
      objectId: state.object.objectId,
      schema: state.object.schema,
      name: state.object.name,
      type: state.object.type
    },
    tab
  });
  const badge = state.mount.querySelector<HTMLElement>('.database-ai-context-badge');
  if (badge) {
    badge.textContent = t('Rows for ChatGPT · 0 selected');
    badge.classList.remove('has-selection');
  }
  if (tab === 'data') {
    openDatabaseTableGrid(content, state.connection, state.object, state.accessMode);
    return;
  }
  const cached = state.cache.get(tab);
  if (cached) {
    renderDetails(content, cached);
    return;
  }
  const token = state.generation;
  content.replaceChildren(el('div', 'database-detail-loading', () => t('Loading object details…')));
  const result = await run(api.readDatabaseObjectDetails({
    connection: state.connection,
    objectId: state.object.objectId,
    section: tab
  }));
  if (active !== state || token !== state.generation || state.activeTab !== tab) return;
  if (!result) {
    const error = el('div', 'database-detail-empty');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn';
    retry.textContent = t('Retry');
    retry.addEventListener('click', () => void activate(state, tab));
    error.append(
      el('strong', '', () => t('Could not load object details.')),
      el('p', '', () => t('The SQL Server request failed or timed out. You can retry this tab.')),
      retry
    );
    content.replaceChildren(error);
    return;
  }
  state.cache.set(tab, result);
  renderDetails(content, result);
}

export function openDatabaseObjectWorkspace(mount: HTMLElement, connection: string, object: DatabaseObjectSummary, accessMode: DatabaseAccessMode): void {
  closeDatabaseObjectWorkspace();
  const state: WorkspaceState = {
    generation: 1,
    mount,
    connection,
    object,
    accessMode,
    cache: new Map(),
    activeTab: initialTab(object)
  };
  active = state;
  mount.classList.remove('database-grid-host', 'is-loading');
  mount.classList.add('database-object-workspace');

  const head = el('div', 'database-object-workspace-head');
  const identity = el('div', 'database-object-workspace-identity');
  identity.append(
    el('h3', '', `${object.schema}.${object.name}`),
    el('span', '', `${t(object.type === 'procedure' ? 'Stored procedure' : object.type[0]!.toUpperCase() + object.type.slice(1))} · ID ${object.objectId}`)
  );
  const tabs = el('div', 'database-object-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const tab of tabsFor(object)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'database-object-tab';
    button.dataset.tab = tab;
    button.setAttribute('role', 'tab');
    button.textContent = label(tab);
    button.addEventListener('click', () => void activate(state, tab));
    tabs.append(button);
  }
  const contextHelp = el('details', 'database-ai-context-help');
  const contextBadge = el('summary', 'database-ai-context-badge', () => t('Rows for ChatGPT · 0 selected'));
  const contextExplanation = el('div', 'database-ai-context-explainer');
  const clearRows = document.createElement('button');
  clearRows.type = 'button';
  clearRows.className = 'btn database-ai-context-clear';
  clearRows.textContent = t('Clear rows');
  clearRows.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    clearDatabaseTableSharedRows();
  });
  const askChatGPT = document.createElement('button');
  askChatGPT.type = 'button';
  askChatGPT.className = 'btn is-primary database-ai-context-ask';
  askChatGPT.textContent = t('Ask ChatGPT');
  askChatGPT.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new window.CustomEvent('cos:database-open-chat'));
  });
  contextExplanation.append(
    el('strong', '', () => t('Use selected rows with ChatGPT')),
    el('p', '', () => t('Press + beside a row to add its values to the current Database Workspace context.')),
    el('p', '', () => t('Choose Ask ChatGPT to return to the current conversation. Shift-click + does both in one step.')),
    el('p', '', () => t('The active database, object, filters, sort and page are included automatically; row values are included only when you select them.')),
    askChatGPT,
    clearRows
  );
  contextHelp.append(contextBadge, contextExplanation);
  identity.append(contextHelp);
  head.append(identity, tabs);
  const content = el('div', 'database-object-workspace-content');
  mount.replaceChildren(head, content);
  void activate(state, state.activeTab);
}

export function closeDatabaseObjectWorkspace(): void {
  closeDatabaseTableGrid();
  if (active) active.generation += 1;
  if (active?.mount) active.mount.classList.remove('database-object-workspace', 'database-grid-host', 'is-loading');
  active = null;
}

