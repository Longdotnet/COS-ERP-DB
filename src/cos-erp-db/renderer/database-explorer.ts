import type { AppApi } from '../../preload/index.js';
import type {
  DatabaseObjectSummary,
  DatabaseObjectType,
  DatabaseSettingsState
} from '../../shared/database.js';
import { el, run } from '../../renderer/dom.js';
import { t } from './i18n.js';
import { closeDatabaseObjectWorkspace, openDatabaseObjectWorkspace } from './database-object-workspace.js';
import { publishDatabaseWorkspaceContext } from './database-workspace-context.js';

const api = (window as Window & { api: AppApi }).api;
const PAGE_SIZE = 50;

const GROUPS: ReadonlyArray<{ type: DatabaseObjectType; label: string }> = [
  { type: 'table', label: 'Tables' },
  { type: 'view', label: 'Views' },
  { type: 'procedure', label: 'Stored procedures' },
  { type: 'function', label: 'Functions' },
  { type: 'synonym', label: 'Synonyms' }
];

interface PageState {
  objects: DatabaseObjectSummary[];
  nextCursor?: string;
  loading: boolean;
  loaded: boolean;
}

let root: HTMLElement | null = null;
let settings: DatabaseSettingsState | null = null;
let selectedConnection = '';
let generation = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
const pages = new Map<string, PageState>();

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing database explorer element #${id}`);
  return node;
}

function pageKey(type: DatabaseObjectType | 'search'): string {
  return `${selectedConnection}\u0000${type}\u0000${type === 'search' ? searchText() : ''}`;
}

function searchText(): string {
  return (document.getElementById('databaseObjectSearch') as HTMLInputElement | null)?.value.trim() ?? '';
}

function connectionProfile() {
  return settings?.settings.connections.find(profile => profile.id === selectedConnection);
}

function objectLabel(object: DatabaseObjectSummary): string {
  return `${object.schema}.${object.name}`;
}

function renderPreview(object?: DatabaseObjectSummary): void {
  const preview = $('databaseObjectPreview');
  closeDatabaseObjectWorkspace();
  preview.classList.remove('database-object-workspace', 'database-grid-host', 'is-loading');
  if (!object) {
    publishDatabaseWorkspaceContext(selectedConnection ? { connection: selectedConnection } : null);
    preview.replaceChildren(
      el('div', 'database-object-preview-empty', () => t('Select an object to inspect it.'))
    );
    return;
  }
  openDatabaseObjectWorkspace(preview, selectedConnection, object, connectionProfile()?.accessMode ?? 'read-only');
}

function objectRow(object: DatabaseObjectSummary): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'database-object-row';
  button.dataset.objectId = String(object.objectId);
  button.title = objectLabel(object);
  const schema = el('span', 'database-object-schema', object.schema);
  const name = el('span', 'database-object-name', object.name);
  button.append(schema, name);
  button.addEventListener('click', () => {
    root?.querySelectorAll('.database-object-row.is-selected').forEach(node => node.classList.remove('is-selected'));
    button.classList.add('is-selected');
    renderPreview(object);
  });
  return button;
}

function renderRows(container: HTMLElement, page: PageState, emptyText: string): void {
  const rows: HTMLElement[] = page.objects.map(objectRow);
  if (rows.length === 0 && page.loaded && !page.loading) rows.push(el('p', 'database-object-empty', () => t(emptyText)));
  container.replaceChildren(...rows);
}

function groupElements(type: DatabaseObjectType): { body: HTMLElement; more: HTMLButtonElement; count: HTMLElement } {
  return {
    body: $(`databaseObjects-${type}`),
    more: $(`databaseObjectsMore-${type}`) as HTMLButtonElement,
    count: $(`databaseObjectsCount-${type}`)
  };
}

function resetPages(): void {
  generation += 1;
  pages.clear();
  renderPreview();
  for (const group of GROUPS) {
    const { body, more, count } = groupElements(group.type);
    body.replaceChildren(el('p', 'database-object-empty', () => t('Expand to load objects.')));
    more.hidden = true;
    more.disabled = false;
    count.textContent = '';
  }
  $('databaseSearchResults').replaceChildren();
  ($('databaseSearchMore') as HTMLButtonElement).hidden = true;
  $('databaseSearchStatus').textContent = '';
}

async function loadPage(type: DatabaseObjectType | 'search', append: boolean): Promise<void> {
  if (!selectedConnection) return;
  const key = pageKey(type);
  const current = pages.get(key) ?? { objects: [], loading: false, loaded: false };
  if (current.loading || (append && !current.nextCursor)) return;
  const token = generation;
  current.loading = true;
  pages.set(key, current);

  const isSearch = type === 'search';
  const more = isSearch ? $('databaseSearchMore') as HTMLButtonElement : groupElements(type).more;
  more.disabled = true;
  if (isSearch) $('databaseSearchStatus').textContent = t('Searching…');

  const result = await run(api.searchDatabaseObjects({
    connection: selectedConnection,
    ...(isSearch && searchText() ? { search: searchText() } : {}),
    ...(!isSearch ? { types: [type] } : {}),
    limit: PAGE_SIZE,
    ...(append && current.nextCursor ? { cursor: current.nextCursor } : {})
  }));

  if (token !== generation || key !== pageKey(type)) return;
  current.loading = false;
  if (!result) {
    more.disabled = false;
    if (isSearch) $('databaseSearchStatus').textContent = t('Object search failed.');
    return;
  }
  current.loaded = true;
  current.objects = append ? [...current.objects, ...result.objects] : result.objects;
  current.nextCursor = result.nextCursor;
  pages.set(key, current);
  more.hidden = !result.hasMore;
  more.disabled = false;

  if (isSearch) {
    renderRows($('databaseSearchResults'), current, 'No matching objects.');
    $('databaseSearchStatus').textContent = t('{0} objects · {1} ms', [current.objects.length, result.elapsedMs]);
  } else {
    const elements = groupElements(type);
    renderRows(elements.body, current, 'No objects in this group.');
    elements.count.textContent = String(current.objects.length) + (result.hasMore ? '+' : '');
  }
}

function applySearchMode(): void {
  const searching = searchText() !== '';
  $('databaseObjectGroups').hidden = searching;
  $('databaseObjectSearchPane').hidden = !searching;
  generation += 1;
  pages.clear();
  renderPreview();
  if (searching) void loadPage('search', false);
}

function scheduleSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    applySearchMode();
  }, 220);
}

function group(type: DatabaseObjectType, label: string): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'database-object-group';
  details.dataset.objectType = type;
  const summary = document.createElement('summary');
  const chev = el('span', 'database-object-chevron', '›');
  const title = el('span', 'database-object-group-title', () => t(label));
  const count = el('span', 'database-object-count');
  count.id = `databaseObjectsCount-${type}`;
  summary.append(chev, title, count);
  const body = el('div', 'database-object-list');
  body.id = `databaseObjects-${type}`;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'database-object-more';
  more.id = `databaseObjectsMore-${type}`;
  more.textContent = t('Load more');
  more.hidden = true;
  more.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void loadPage(type, true);
  });
  details.append(summary, body, more);
  details.addEventListener('toggle', () => {
    if (!details.open || searchText() !== '') return;
    const page = pages.get(pageKey(type));
    if (!page?.loaded && !page?.loading) void loadPage(type, false);
  });
  return details;
}

function build(mount: HTMLElement): void {
  const shell = el('section', 'database-explorer');
  shell.id = 'databaseExplorer';
  const head = el('div', 'database-explorer-head');
  const heading = el('div');
  heading.append(el('h2', '', () => t('Object Explorer')), el('p', '', () => t('Browse SQL Server metadata lazily without loading the whole schema.')));
  const controls = el('div', 'database-explorer-controls');
  const connection = document.createElement('select');
  connection.id = 'databaseExplorerConnection';
  connection.setAttribute('aria-label', t('Explorer connection'));
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.id = 'databaseExplorerRefresh';
  refresh.className = 'btn';
  refresh.textContent = t('Refresh');
  controls.append(connection, refresh);
  head.append(heading, controls);

  const search = document.createElement('input');
  search.id = 'databaseObjectSearch';
  search.type = 'search';
  search.placeholder = t('Search schema or object name…');
  search.autocomplete = 'off';
  search.spellcheck = false;

  const workspace = el('div', 'database-explorer-workspace');
  const navigator = el('div', 'database-object-navigator');
  const groups = el('div', 'database-object-groups');
  groups.id = 'databaseObjectGroups';
  for (const item of GROUPS) groups.append(group(item.type, item.label));
  const searchPane = el('div', 'database-object-search-pane');
  searchPane.id = 'databaseObjectSearchPane';
  searchPane.hidden = true;
  const searchStatus = el('p', 'database-search-status');
  searchStatus.id = 'databaseSearchStatus';
  const searchResults = el('div', 'database-object-list');
  searchResults.id = 'databaseSearchResults';
  const searchMore = document.createElement('button');
  searchMore.type = 'button';
  searchMore.id = 'databaseSearchMore';
  searchMore.className = 'database-object-more';
  searchMore.textContent = t('Load more');
  searchMore.hidden = true;
  searchMore.addEventListener('click', () => void loadPage('search', true));
  searchPane.append(searchStatus, searchResults, searchMore);
  navigator.append(search, groups, searchPane);

  const preview = el('div', 'database-object-preview');
  preview.id = 'databaseObjectPreview';
  workspace.append(navigator, preview);
  shell.append(head, workspace);
  mount.append(shell);

  connection.addEventListener('change', () => {
    selectedConnection = connection.value;
    publishDatabaseWorkspaceContext(selectedConnection ? { connection: selectedConnection } : null);
    resetPages();
    applySearchMode();
  });
  search.addEventListener('input', scheduleSearch);
  refresh.addEventListener('click', () => {
    resetPages();
    applySearchMode();
    for (const details of root!.querySelectorAll<HTMLDetailsElement>('.database-object-group[open]')) {
      const type = details.dataset.objectType as DatabaseObjectType;
      void loadPage(type, false);
    }
  });
  root = shell;
  resetPages();
}

export function initDatabaseExplorer(mount: HTMLElement): void {
  if (root) return;
  build(mount);
}

export function setDatabaseExplorerState(next: DatabaseSettingsState): void {
  settings = next;
  if (!root) return;
  const select = $('databaseExplorerConnection') as HTMLSelectElement;
  const previous = selectedConnection;
  select.replaceChildren(...next.settings.connections.map(profile => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} · ${profile.database}`;
    return option;
  }));
  const available = next.settings.connections.some(profile => profile.id === previous);
  selectedConnection = available ? previous : next.settings.defaultConnectionId ?? next.settings.connections[0]?.id ?? '';
  select.value = selectedConnection;
  select.disabled = next.settings.connections.length === 0;
  ($('databaseObjectSearch') as HTMLInputElement).disabled = next.settings.connections.length === 0;
  ($('databaseExplorerRefresh') as HTMLButtonElement).disabled = next.settings.connections.length === 0;
  const profile = connectionProfile();
  root.dataset.empty = String(!profile);
  resetPages();
  if (!profile) {
    publishDatabaseWorkspaceContext(null);
    $('databaseObjectPreview').replaceChildren(el('div', 'database-object-preview-empty', () => t('Add a SQL Server connection to browse objects.')));
  }
}

export function openDatabaseExplorerObject(connection: string, object: DatabaseObjectSummary): void {
  if (!root || !settings) return;
  const profile = settings.settings.connections.find(candidate => candidate.id === connection);
  if (!profile) return;
  selectedConnection = connection;
  const select = $('databaseExplorerConnection') as HTMLSelectElement;
  select.value = connection;
  resetPages();
  renderPreview(object);
  root.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}
