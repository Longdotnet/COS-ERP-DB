import type { AppApi } from '../../preload/index.js';
import type {
  DatabaseAccessMode,
  DatabaseObjectSummary,
  DatabaseScalarValue,
  DatabaseTableColumn,
  DatabaseTableFilter,
  DatabaseTableFilterOperator,
  DatabaseTablePageResult,
  DatabaseTableSort
} from '../../shared/database.js';
import { el, run } from '../../renderer/dom.js';
import { t } from './i18n.js';
import { publishDatabaseWorkspaceContext } from './database-workspace-context.js';
import { copyDatabaseText } from './database-clipboard.js';

const api = (window as Window & { api: AppApi }).api;
const PAGE_SIZE = 100;
const BUFFER_ROWS = 6;
const DEFAULT_COLUMN_WIDTH = 150;
const MIN_COLUMN_WIDTH = 80;
const MAX_COLUMN_WIDTH = 900;
const TEXT_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'sysname']);
const NUMBER_TYPES = new Set(['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney']);
type GridDensity = 'compact' | 'normal' | 'comfortable';
const GRID_ROW_HEIGHT: Record<GridDensity, number> = { compact: 24, normal: 30, comfortable: 38 };

interface GridState {
  connection: string;
  object: DatabaseObjectSummary;
  accessMode: DatabaseAccessMode;
  page: DatabaseTablePageResult | null;
  pageStarts: Array<string | undefined>;
  pageIndex: number;
  sort?: DatabaseTableSort;
  filters: DatabaseTableFilter[];
  selectedRows: Set<number>;
  columnWidths: Map<string, number>;
  hiddenColumns: Set<string>;
  density: GridDensity;
  inspectorOpen: boolean;
  focusedCell?: { rowIndex: number; columnIndex: number };
  allCellsSelected: boolean;
  pendingEdit?: PendingCellEdit;
  savingEdit: boolean;
  generation: number;
}

interface PendingCellEdit {
  rowIndex: number;
  columnIndex: number;
  column: string;
  primaryKey: Record<string, DatabaseScalarValue>;
  originalValue: DatabaseScalarValue;
  value: DatabaseScalarValue;
}

let activeState: GridState | null = null;
let activeMount: HTMLElement | null = null;

function rowHeight(state: GridState): number {
  return GRID_ROW_HEIGHT[state.density];
}

function visibleColumnEntries(state: GridState): Array<{ column: DatabaseTableColumn; index: number }> {
  return (state.page?.columns ?? [])
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !state.hiddenColumns.has(column.name));
}

function updateContextBadge(mount: HTMLElement, selectedCount: number): void {
  const badge = mount.closest('.database-object-workspace')?.querySelector<HTMLElement>('.database-ai-context-badge');
  if (!badge) return;
  badge.textContent = t('Rows for ChatGPT · {0} selected', [selectedCount]);
  badge.classList.toggle('has-selection', selectedCount > 0);
}

function updateContextRowVisual(mount: HTMLElement, state: GridState, rowIndex: number): void {
  const row = mount.querySelector<HTMLTableRowElement>(`.database-data-grid tbody tr[data-row-index="${rowIndex}"]`);
  if (!row) return;
  const selected = state.selectedRows.has(rowIndex);
  row.classList.toggle('is-context-selected', selected);
  row.setAttribute('aria-selected', String(selected));
  const toggle = row.querySelector<HTMLButtonElement>('.database-ai-row-toggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(selected));
    toggle.classList.toggle('is-shared', selected);
    toggle.textContent = selected ? '✓' : '+';
    toggle.title = selected ? t('Remove this row from ChatGPT selection') : t('Add this row for ChatGPT');
  }
}

function requestChatForDatabaseContext(): void {
  window.dispatchEvent(new window.CustomEvent('cos:database-open-chat'));
}

function toggleContextRow(mount: HTMLElement, state: GridState, rowIndex: number): void {
  if (state.selectedRows.has(rowIndex)) {
    state.selectedRows.delete(rowIndex);
  } else if (state.selectedRows.size < 10) {
    state.selectedRows.add(rowIndex);
  } else {
    setStatus(mount, t('You can select at most 10 rows for ChatGPT.'), true);
    return;
  }
  updateContextRowVisual(mount, state, rowIndex);
  publishGridContext(mount, state);
}

function publishGridContext(mount: HTMLElement, state: GridState): void {
  const selectedRows = state.page
    ? [...state.selectedRows].sort((a, b) => a - b).map(index => state.page!.rows[index]).filter((row): row is Record<string, unknown> => Boolean(row))
    : [];
  publishDatabaseWorkspaceContext({
    connection: state.connection,
    object: {
      objectId: state.object.objectId,
      schema: state.object.schema,
      name: state.object.name,
      type: state.object.type
    },
    tab: 'data',
    ...(state.filters.length ? { filters: state.filters } : {}),
    ...(state.sort ? { sort: state.sort } : {}),
    page: state.pageIndex + 1,
    ...(selectedRows.length ? { selectedRows } : {})
  });
  updateContextBadge(mount, selectedRows.length);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function scalarCellValue(value: unknown, field: string): DatabaseScalarValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  throw new Error(`${field} cannot be edited inline.`);
}

function parseCellEditValue(column: DatabaseTableColumn, raw: string): DatabaseScalarValue {
  if (column.nullable && raw.trim() === '<NULL>') return null;
  const type = column.type.toLocaleLowerCase();
  if (NUMBER_TYPES.has(type)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(t('Enter a valid number for this column.'));
    return value;
  }
  if (type === 'bit') {
    const normalized = raw.trim().toLocaleLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
    if (normalized === '0' || normalized === 'false') return false;
    throw new Error(t('Enter true/false or 1/0 for this column.'));
  }
  return raw;
}

function primaryKeyValues(state: GridState, rowIndex: number): Record<string, DatabaseScalarValue> {
  const page = state.page;
  const row = page?.rows[rowIndex];
  if (!page || !row) throw new Error(t('The selected row is no longer available.'));
  const keys = page.columns
    .filter(column => column.primaryKeyOrdinal !== null)
    .sort((left, right) => left.primaryKeyOrdinal! - right.primaryKeyOrdinal!);
  if (keys.length === 0) throw new Error(t('Inline edit requires a primary key.'));
  const result: Record<string, DatabaseScalarValue> = {};
  for (const column of keys) {
    const value = scalarCellValue(row[column.name], column.name);
    if (value === null) throw new Error(t('Primary-key values cannot be null.'));
    result[column.name] = value;
  }
  return result;
}

function editBlockedReason(state: GridState, column: DatabaseTableColumn): string | null {
  if (state.accessMode !== 'full-access') return t('This connection is Read-only. Switch it to Full access to edit data.');
  if (!state.page?.columns.some(candidate => candidate.primaryKeyOrdinal !== null)) return t('Inline edit requires a primary key.');
  if (column.primaryKeyOrdinal !== null) return t('Primary-key columns cannot be edited inline.');
  if (column.identity) return t('Identity columns cannot be edited inline.');
  if (column.computed) return t('Computed columns cannot be edited inline.');
  return null;
}

function sameScalar(left: DatabaseScalarValue, right: DatabaseScalarValue): boolean {
  return Object.is(left, right);
}

function tsvCell(value: unknown): string {
  return cellText(value).replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ');
}

function selectedGridText(state: GridState): string | null {
  const page = state.page;
  if (!page) return null;
  const columns = visibleColumnEntries(state).map(entry => entry.column);
  if (state.allCellsSelected) {
    return [
      columns.map(column => tsvCell(column.name)).join('\t'),
      ...page.rows.map(row => columns.map(column => tsvCell(row[column.name])).join('\t'))
    ].join('\r\n');
  }
  const focused = state.focusedCell;
  if (!focused) return null;
  const column = page.columns[focused.columnIndex];
  const row = page.rows[focused.rowIndex];
  if (!column || !row) return null;
  return tsvCell(row[column.name]);
}

function updateCellSelectionVisuals(mount: HTMLElement, state: GridState): void {
  mount.querySelectorAll<HTMLTableCellElement>('.database-data-grid tbody td[data-row-index][data-column-index]').forEach(cell => {
    const rowIndex = Number(cell.dataset.rowIndex);
    const columnIndex = Number(cell.dataset.columnIndex);
    const focused = state.focusedCell?.rowIndex === rowIndex && state.focusedCell.columnIndex === columnIndex;
    cell.classList.toggle('is-grid-focused', focused && !state.allCellsSelected);
    cell.classList.toggle('is-grid-selected-all', state.allCellsSelected);
    cell.setAttribute('aria-selected', String(state.allCellsSelected || focused));
  });
}

async function copyGridSelection(mount: HTMLElement, state: GridState): Promise<void> {
  const text = selectedGridText(state);
  if (text === null) return;
  const copied = await copyDatabaseText(text);
  if (!copied) {
    setStatus(mount, t('Could not copy to clipboard.'), true);
    return;
  }
  setStatus(
    mount,
    state.allCellsSelected
      ? t('Copied {0} rows with headers.', [state.page?.rows.length ?? 0])
      : t('Copied cell value.')
  );
}

function clampColumnWidth(width: number): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
}

function columnWidth(state: GridState, column: DatabaseTableColumn): number {
  return state.columnWidths.get(column.name) ?? DEFAULT_COLUMN_WIDTH;
}

function autoFitColumnWidth(state: GridState, column: DatabaseTableColumn): number {
  const page = state.page;
  if (!page) return DEFAULT_COLUMN_WIDTH;
  const candidates = [
    `${column.name} ${column.type}`,
    ...page.rows.map(row => cellText(row[column.name]))
  ];
  const longest = candidates.reduce((max, value) => Math.max(max, value.length), 0);
  return clampColumnWidth(34 + longest * 7.2);
}

function applyColumnWidths(mount: HTMLElement, state: GridState): void {
  if (!state.page) return;
  const cols = mount.querySelectorAll<HTMLTableColElement>('.database-data-grid colgroup col[data-column]');
  visibleColumnEntries(state).forEach(({ column }, index) => {
    const col = cols[index];
    if (!col) return;
    col.style.width = `${columnWidth(state, column)}px`;
  });
}

function installColumnResize(
  mount: HTMLElement,
  state: GridState,
  column: DatabaseTableColumn,
  th: HTMLTableCellElement
): void {
  const handle = document.createElement('span');
  handle.className = 'database-grid-column-resize';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', t('Resize {0} column', [column.name]));
  handle.title = t('Drag to resize · double-click to auto-fit');
  handle.tabIndex = 0;

  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidth(state, column);
    handle.classList.add('is-resizing');
    const move = (moveEvent: PointerEvent) => {
      state.columnWidths.set(column.name, clampColumnWidth(startWidth + moveEvent.clientX - startX));
      applyColumnWidths(mount, state);
    };
    const stop = () => {
      handle.classList.remove('is-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });

  handle.addEventListener('dblclick', event => {
    event.preventDefault();
    event.stopPropagation();
    state.columnWidths.set(column.name, autoFitColumnWidth(state, column));
    applyColumnWidths(mount, state);
  });

  handle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.key === 'ArrowLeft' ? -16 : 16;
    state.columnWidths.set(column.name, clampColumnWidth(columnWidth(state, column) + delta));
    applyColumnWidths(mount, state);
  });
  th.append(handle);
}

function parseFilterValue(column: DatabaseTableColumn, raw: string): string | number | boolean {
  const type = column.type.toLocaleLowerCase();
  if (NUMBER_TYPES.has(type)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(t('Enter a valid number for this column.'));
    return value;
  }
  if (type === 'bit') {
    const normalized = raw.trim().toLocaleLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
    if (normalized === '0' || normalized === 'false') return false;
    throw new Error(t('Enter true/false or 1/0 for this column.'));
  }
  return raw;
}

function operatorLabel(operator: DatabaseTableFilterOperator): string {
  switch (operator) {
    case 'eq': return t('Equals');
    case 'starts_with': return t('Starts with');
    case 'contains': return t('Contains');
    case 'gte': return '≥';
    case 'lte': return '≤';
    case 'is_null': return t('Is null');
  }
}

function operatorOptions(column?: DatabaseTableColumn): DatabaseTableFilterOperator[] {
  if (!column) return ['eq'];
  const common: DatabaseTableFilterOperator[] = ['eq', 'gte', 'lte', 'is_null'];
  return TEXT_TYPES.has(column.type.toLocaleLowerCase()) ? ['eq', 'starts_with', 'contains', 'gte', 'lte', 'is_null'] : common;
}

function setStatus(mount: HTMLElement, text: string, warning = false): void {
  const status = mount.querySelector<HTMLElement>('.database-grid-status');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('is-warn', warning);
}

function updateEditActions(mount: HTMLElement, state: GridState): void {
  const actions = mount.querySelector<HTMLElement>('.database-grid-edit-actions');
  const save = mount.querySelector<HTMLButtonElement>('.database-grid-save-edit');
  const revert = mount.querySelector<HTMLButtonElement>('.database-grid-revert-edit');
  const summary = mount.querySelector<HTMLElement>('.database-grid-edit-summary');
  if (!actions || !save || !revert || !summary) return;
  actions.hidden = !state.pendingEdit;
  save.disabled = state.savingEdit || !state.pendingEdit;
  revert.disabled = state.savingEdit || !state.pendingEdit;
  if (!state.pendingEdit) {
    summary.textContent = '';
    return;
  }
  summary.textContent = t('1 unsaved change · {0}: {1} → {2}', [
    state.pendingEdit.column,
    cellText(state.pendingEdit.originalValue),
    cellText(state.pendingEdit.value)
  ]);
}

function allowGridNavigation(mount: HTMLElement, state: GridState): boolean {
  if (!state.pendingEdit) return true;
  setStatus(mount, t('Save or revert the pending change before changing sort, filters or page.'), true);
  return false;
}

function pendingFor(state: GridState, rowIndex: number, columnIndex: number): PendingCellEdit | undefined {
  const pending = state.pendingEdit;
  return pending?.rowIndex === rowIndex && pending.columnIndex === columnIndex ? pending : undefined;
}

function beginCellEdit(
  mount: HTMLElement,
  state: GridState,
  cell: HTMLTableCellElement,
  rowIndex: number,
  columnIndex: number
): void {
  const page = state.page;
  const column = page?.columns[columnIndex];
  const row = page?.rows[rowIndex];
  if (!page || !column || !row) return;
  if (state.pendingEdit && !pendingFor(state, rowIndex, columnIndex)) {
    setStatus(mount, t('Save or revert the pending change before editing another cell.'), true);
    return;
  }
  const previousPending = pendingFor(state, rowIndex, columnIndex);
  const blocked = editBlockedReason(state, column);
  if (blocked) {
    setStatus(mount, blocked, true);
    return;
  }

  let originalValue: DatabaseScalarValue;
  let primaryKey: Record<string, DatabaseScalarValue>;
  try {
    originalValue = previousPending?.originalValue ?? scalarCellValue(row[column.name], column.name);
    primaryKey = previousPending?.primaryKey ?? primaryKeyValues(state, rowIndex);
  } catch (error) {
    setStatus(mount, error instanceof Error ? error.message : String(error), true);
    return;
  }
  const startingValue = previousPending?.value ?? originalValue;
  const input = document.createElement('input');
  input.className = 'database-grid-cell-editor';
  input.type = 'text';
  input.value = startingValue === null ? '<NULL>' : cellText(startingValue);
  input.setAttribute('aria-label', t('Edit {0}', [column.name]));
  cell.classList.add('is-editing');
  cell.replaceChildren(input);
  input.focus();
  input.select();

  let settled = false;
  const restore = () => {
    if (settled) return;
    settled = true;
    renderGridRows(mount, state);
    updateEditActions(mount, state);
  };
  const commit = () => {
    if (settled) return;
    try {
      const value = parseCellEditValue(column, input.value);
      state.pendingEdit = sameScalar(value, originalValue)
        ? undefined
        : { rowIndex, columnIndex, column: column.name, primaryKey, originalValue, value };
      state.focusedCell = { rowIndex, columnIndex };
      settled = true;
      renderGridRows(mount, state);
      updateEditActions(mount, state);
      setStatus(
        mount,
        state.pendingEdit
          ? t('1 pending change · Save changes to update SQL Server.')
          : t('No changes to save.')
      );
    } catch (error) {
      setStatus(mount, error instanceof Error ? error.message : String(error), true);
      input.focus();
      input.select();
    }
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      state.pendingEdit = previousPending;
      restore();
    }
  });
  input.addEventListener('blur', commit, { once: true });
}

async function savePendingEdit(mount: HTMLElement, state: GridState): Promise<void> {
  const pending = state.pendingEdit;
  const page = state.page;
  if (!pending || !page || state.savingEdit) return;
  state.savingEdit = true;
  updateEditActions(mount, state);
  setStatus(mount, t('Saving change…'));
  const result = await run(api.updateDatabaseTableCell({
    connection: state.connection,
    objectId: state.object.objectId,
    column: pending.column,
    primaryKey: pending.primaryKey,
    originalValue: pending.originalValue,
    value: pending.value
  }));
  state.savingEdit = false;
  if (!result) {
    updateEditActions(mount, state);
    setStatus(mount, t('Could not save the pending change.'), true);
    return;
  }
  const row = page.rows[pending.rowIndex];
  if (row) row[pending.column] = pending.value;
  state.pendingEdit = undefined;
  renderGridRows(mount, state);
  updateEditActions(mount, state);
  publishGridContext(mount, state);
  setStatus(mount, t('Updated 1 cell in {0} ms.', [result.elapsedMs]));
}

function renderFilterChips(mount: HTMLElement, state: GridState): void {
  const chips = mount.querySelector<HTMLElement>('.database-grid-filter-chips')!;
  chips.replaceChildren(...state.filters.map((filter, index) => {
    const chip = el('button', 'database-grid-filter-chip');
    chip.setAttribute('type', 'button');
    chip.title = t('Remove filter');
    const value = filter.operator === 'is_null' ? '' : ` ${String(filter.value ?? '')}`;
    chip.textContent = `${filter.column} ${operatorLabel(filter.operator)}${value} ×`;
    chip.addEventListener('click', () => {
      state.filters.splice(index, 1);
      resetPaging(state);
      renderFilterChips(mount, state);
      void loadCurrentPage(mount, state);
    });
    return chip;
  }));
}

function configureFilterOperators(mount: HTMLElement, state: GridState): void {
  const columnSelect = mount.querySelector<HTMLSelectElement>('.database-grid-filter-column')!;
  const operatorSelect = mount.querySelector<HTMLSelectElement>('.database-grid-filter-operator')!;
  const valueInput = mount.querySelector<HTMLInputElement>('.database-grid-filter-value')!;
  const column = state.page?.columns.find(item => item.name === columnSelect.value);
  const previous = operatorSelect.value as DatabaseTableFilterOperator;
  const operators = operatorOptions(column);
  operatorSelect.replaceChildren(...operators.map(operator => {
    const option = document.createElement('option');
    option.value = operator;
    option.textContent = operatorLabel(operator);
    return option;
  }));
  operatorSelect.value = operators.includes(previous) ? previous : operators[0]!;
  valueInput.disabled = operatorSelect.value === 'is_null';
}

function resetPaging(state: GridState): void {
  state.pageStarts = [undefined];
  state.pageIndex = 0;
  state.selectedRows.clear();
}

function renderGridRows(mount: HTMLElement, state: GridState): void {
  const page = state.page;
  if (!page) return;
  const visibleColumns = visibleColumnEntries(state);
  const height = rowHeight(state);
  const viewport = mount.querySelector<HTMLElement>('.database-grid-scroll')!;
  const body = mount.querySelector<HTMLTableSectionElement>('tbody')!;
  const visibleHeight = Math.max(height, viewport.clientHeight || 300);
  const start = Math.max(0, Math.floor(viewport.scrollTop / height) - BUFFER_ROWS);
  const count = Math.ceil(visibleHeight / height) + BUFFER_ROWS * 2;
  const end = Math.min(page.rows.length, start + count);
  const rows: HTMLTableRowElement[] = [];

  if (start > 0) {
    const spacer = document.createElement('tr');
    spacer.className = 'database-grid-spacer';
    spacer.style.height = `${start * height}px`;
    const cell = document.createElement('td');
    cell.colSpan = Math.max(1, visibleColumns.length + 1);
    spacer.append(cell);
    rows.push(spacer);
  }

  for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
    const row = document.createElement('tr');
    row.dataset.rowIndex = String(rowIndex);
    row.classList.toggle('is-context-selected', state.selectedRows.has(rowIndex));
    row.setAttribute('aria-selected', String(state.selectedRows.has(rowIndex)));
    const shareCell = document.createElement('td');
    shareCell.className = 'database-ai-row-cell';
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'database-ai-row-toggle';
    share.setAttribute('aria-pressed', String(state.selectedRows.has(rowIndex)));
    share.classList.toggle('is-shared', state.selectedRows.has(rowIndex));
    share.setAttribute('aria-label', t('Add row {0} for ChatGPT', [rowIndex + 1]));
    share.title = state.selectedRows.has(rowIndex) ? t('Remove this row from ChatGPT selection') : t('Add this row for ChatGPT');
    share.textContent = state.selectedRows.has(rowIndex) ? '✓' : '+';
    share.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      toggleContextRow(mount, state, rowIndex);
      if (event.shiftKey && state.selectedRows.has(rowIndex)) requestChatForDatabaseContext();
    });
    shareCell.append(share);
    row.append(shareCell);
    visibleColumns.forEach(({ column, index: columnIndex }) => {
      const cell = document.createElement('td');
      const pending = pendingFor(state, rowIndex, columnIndex);
      const value = pending ? pending.value : page.rows[rowIndex]?.[column.name];
      const text = cellText(value);
      cell.textContent = text;
      const blockedReason = editBlockedReason(state, column);
      cell.title = pending
        ? t('Pending: {0} · original: {1}', [text, cellText(pending.originalValue)])
        : blockedReason
          ? `${text} · ${blockedReason}`
          : `${text} · ${t('Double-click to edit')}`;
      cell.tabIndex = 0;
      cell.dataset.rowIndex = String(rowIndex);
      cell.dataset.columnIndex = String(columnIndex);
      cell.classList.toggle('is-editable', blockedReason === null);
      const focused = state.focusedCell?.rowIndex === rowIndex && state.focusedCell.columnIndex === columnIndex;
      cell.classList.toggle('is-grid-focused', focused && !state.allCellsSelected);
      cell.classList.toggle('is-grid-selected-all', state.allCellsSelected);
      cell.classList.toggle('is-pending-edit', Boolean(pending));
      cell.setAttribute('aria-selected', String(state.allCellsSelected || focused));
      cell.addEventListener('click', event => {
        event.stopPropagation();
        state.focusedCell = { rowIndex, columnIndex };
        state.allCellsSelected = false;
        updateCellSelectionVisuals(mount, state);
        renderRowInspector(mount, state);
      });
      cell.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        beginCellEdit(mount, state, cell, rowIndex, columnIndex);
      });
      if (value === null || value === undefined) cell.classList.add('is-null');
      row.append(cell);
    });
    rows.push(row);
  }

  if (end < page.rows.length) {
    const spacer = document.createElement('tr');
    spacer.className = 'database-grid-spacer';
    spacer.style.height = `${(page.rows.length - end) * height}px`;
    const cell = document.createElement('td');
    cell.colSpan = Math.max(1, visibleColumns.length + 1);
    spacer.append(cell);
    rows.push(spacer);
  }
  body.replaceChildren(...rows);
}

function renderHeader(mount: HTMLElement, state: GridState): void {
  const page = state.page;
  if (!page) return;
  const visibleColumns = visibleColumnEntries(state);
  const colgroup = mount.querySelector<HTMLTableColElement>('colgroup')!;
  const shareCol = document.createElement('col');
  shareCol.className = 'database-ai-share-col';
  colgroup.replaceChildren(shareCol, ...visibleColumns.map(({ column }) => {
    const col = document.createElement('col');
    col.dataset.column = column.name;
    col.style.width = `${columnWidth(state, column)}px`;
    return col;
  }));
  const head = mount.querySelector<HTMLTableRowElement>('thead tr')!;
  const shareHead = document.createElement('th');
  shareHead.className = 'database-ai-share-head';
  shareHead.textContent = t('AI');
  shareHead.title = t('Add rows you want ChatGPT to inspect. Up to 10 rows.');
  head.replaceChildren(shareHead, ...visibleColumns.map(({ column }) => {
    const th = document.createElement('th');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'database-grid-sort';
    const selected = state.sort?.column === column.name;
    button.textContent = `${column.name}${selected ? state.sort!.direction === 'asc' ? ' ↑' : ' ↓' : ''}`;
    button.title = `${column.type}${column.primaryKeyOrdinal ? ` · PK ${column.primaryKeyOrdinal}` : ''}`;
    button.addEventListener('click', () => {
      if (!allowGridNavigation(mount, state)) return;
      state.sort = selected
        ? { column: column.name, direction: state.sort!.direction === 'asc' ? 'desc' : 'asc' }
        : { column: column.name, direction: 'asc' };
      resetPaging(state);
      void loadCurrentPage(mount, state);
    });
    th.append(button);
    installColumnResize(mount, state, column, th);
    return th;
  }));

  const filterColumn = mount.querySelector<HTMLSelectElement>('.database-grid-filter-column')!;
  const previousColumn = filterColumn.value;
  filterColumn.replaceChildren(...page.columns.map(column => {
    const option = document.createElement('option');
    option.value = column.name;
    option.textContent = `${column.name} · ${column.type}`;
    return option;
  }));
  if (page.columns.some(column => column.name === previousColumn)) filterColumn.value = previousColumn;
  configureFilterOperators(mount, state);
}

function renderRowInspector(mount: HTMLElement, state: GridState): void {
  const shell = mount.querySelector<HTMLElement>('.database-grid-body');
  const inspector = mount.querySelector<HTMLElement>('.database-row-inspector');
  if (!shell || !inspector) return;
  shell.classList.toggle('has-inspector', state.inspectorOpen);
  inspector.hidden = !state.inspectorOpen;
  if (!state.inspectorOpen) return;
  const rowIndex = state.focusedCell?.rowIndex;
  const row = rowIndex === undefined ? undefined : state.page?.rows[rowIndex];
  if (rowIndex === undefined || !row || !state.page) {
    inspector.replaceChildren(el('p', 'database-row-inspector-empty', () => t('Select a cell to inspect that row.')));
    return;
  }
  const heading = el('div', 'database-row-inspector-head');
  heading.append(el('strong', '', () => t('Row details')), el('span', '', `#${rowIndex + 1}`));
  const body = el('div', 'database-row-inspector-fields');
  for (const column of state.page.columns) {
    const field = el('div', 'database-row-inspector-field');
    const label = el('span', 'database-row-inspector-label', column.name);
    const value = el('div', 'database-row-inspector-value', cellText(row[column.name]));
    value.title = cellText(row[column.name]);
    field.append(label, value);
    body.append(field);
  }
  inspector.replaceChildren(heading, body);
}

function renderColumnChooser(mount: HTMLElement, state: GridState): void {
  const details = mount.querySelector<HTMLDetailsElement>('.database-grid-columns');
  const summary = details?.querySelector<HTMLElement>('summary');
  const list = details?.querySelector<HTMLElement>('.database-grid-columns-list');
  if (!details || !summary || !list || !state.page) return;
  const visibleCount = visibleColumnEntries(state).length;
  summary.textContent = t('Columns {0}/{1}', [visibleCount, state.page.columns.length]);
  list.replaceChildren(...state.page.columns.map((column, columnIndex) => {
    const row = document.createElement('label');
    row.className = 'database-grid-column-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !state.hiddenColumns.has(column.name);
    const name = el('span', '', column.name);
    const type = el('small', '', column.type);
    row.append(checkbox, name, type);
    checkbox.addEventListener('change', () => {
      if (!checkbox.checked && visibleColumnEntries(state).length <= 1) {
        checkbox.checked = true;
        setStatus(mount, t('Keep at least one column visible.'), true);
        return;
      }
      if (checkbox.checked) state.hiddenColumns.delete(column.name);
      else state.hiddenColumns.add(column.name);
      if (state.focusedCell?.columnIndex === columnIndex && state.hiddenColumns.has(column.name)) state.focusedCell = undefined;
      renderHeader(mount, state);
      renderGridRows(mount, state);
      renderColumnChooser(mount, state);
      renderRowInspector(mount, state);
    });
    return row;
  }));
}

function applyDensity(mount: HTMLElement, state: GridState): void {
  mount.dataset.gridDensity = state.density;
  const select = mount.querySelector<HTMLSelectElement>('.database-grid-density');
  if (select) select.value = state.density;
  renderGridRows(mount, state);
}

function renderPage(mount: HTMLElement, state: GridState): void {
  const page = state.page;
  if (!page) return;
  renderHeader(mount, state);
  renderGridRows(mount, state);
  renderFilterChips(mount, state);
  renderColumnChooser(mount, state);
  renderRowInspector(mount, state);

  const previous = mount.querySelector<HTMLButtonElement>('.database-grid-prev')!;
  const next = mount.querySelector<HTMLButtonElement>('.database-grid-next')!;
  previous.disabled = state.pageIndex === 0;
  next.disabled = !page.hasMore || !page.nextCursor;
  mount.querySelector<HTMLElement>('.database-grid-page')!.textContent = t('Page {0}', [state.pageIndex + 1]);
  const mode = page.pagingMode === 'keyset' ? t('Keyset paging') : t('Offset fallback');
  setStatus(mount, `${page.rows.length} ${t('rows')} · ${page.elapsedMs} ms · ${mode}${page.warning ? ` · ${page.warning}` : ''}`, Boolean(page.warning));
}

async function loadCurrentPage(mount: HTMLElement, state: GridState): Promise<void> {
  const token = ++state.generation;
  setStatus(mount, t('Loading rows…'));
  mount.classList.add('is-loading');
  const cursor = state.pageStarts[state.pageIndex];
  const result = await run(api.readDatabaseTablePage({
    connection: state.connection,
    objectId: state.object.objectId,
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    ...(state.sort ? { sort: state.sort } : {}),
    ...(state.filters.length ? { filters: state.filters } : {})
  }));
  if (token !== state.generation || activeState !== state) return;
  mount.classList.remove('is-loading');
  if (!result) {
    setStatus(mount, t('Could not load table rows.'), true);
    return;
  }
  state.page = result;
  state.selectedRows.clear();
  state.focusedCell = undefined;
  state.allCellsSelected = false;
  const nextIndex = state.pageIndex + 1;
  if (result.nextCursor) state.pageStarts[nextIndex] = result.nextCursor;
  else state.pageStarts.splice(nextIndex);
  const scroll = mount.querySelector<HTMLElement>('.database-grid-scroll')!;
  scroll.scrollTop = 0;
  renderPage(mount, state);
  publishGridContext(mount, state);
}

function buildGrid(mount: HTMLElement, state: GridState): void {
  const toolbar = el('div', 'database-grid-toolbar');
  const titleWrap = el('div', 'database-grid-title');
  const access = el('span', `database-grid-access is-${state.accessMode}`, () => t(state.accessMode === 'full-access' ? 'Full access' : 'Read-only'));
  titleWrap.append(
    el('h3', '', `${state.object.schema}.${state.object.name}`),
    el('span', 'database-grid-object-type', () => t('Table data')),
    access
  );

  const viewTools = el('div', 'database-grid-view-tools');
  const density = document.createElement('select');
  density.className = 'database-grid-density';
  density.setAttribute('aria-label', t('Grid density'));
  density.title = t('Grid size. Use Ctrl++ / Ctrl+- to zoom the whole app.');
  for (const [value, label] of [['compact', 'Compact'], ['normal', 'Normal'], ['comfortable', 'Comfortable']] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = t(label);
    density.append(option);
  }
  density.value = state.density;
  const columnsMenu = document.createElement('details');
  columnsMenu.className = 'database-grid-columns';
  const columnsSummary = document.createElement('summary');
  columnsSummary.textContent = t('Columns');
  const columnsPopover = el('div', 'database-grid-columns-popover');
  const columnsSearch = document.createElement('input');
  columnsSearch.type = 'search';
  columnsSearch.className = 'database-grid-columns-search';
  columnsSearch.placeholder = t('Search columns…');
  const columnsList = el('div', 'database-grid-columns-list');
  columnsPopover.append(columnsSearch, columnsList);
  columnsMenu.append(columnsSummary, columnsPopover);
  const rowDetails = document.createElement('button');
  rowDetails.type = 'button';
  rowDetails.className = 'btn database-grid-row-details-toggle';
  rowDetails.textContent = t('Row details');
  rowDetails.setAttribute('aria-pressed', 'false');
  viewTools.append(density, columnsMenu, rowDetails);
  titleWrap.append(viewTools);

  const editActions = el('div', 'database-grid-edit-actions');
  editActions.hidden = true;
  const editSummary = el('span', 'database-grid-edit-summary');
  const saveEdit = document.createElement('button');
  saveEdit.type = 'button';
  saveEdit.className = 'btn database-grid-save-edit';
  saveEdit.textContent = t('Save 1 change');
  const revertEdit = document.createElement('button');
  revertEdit.type = 'button';
  revertEdit.className = 'btn database-grid-revert-edit';
  revertEdit.textContent = t('Discard');
  editActions.append(editSummary, revertEdit, saveEdit);

  const filter = el('div', 'database-grid-filter');
  const column = document.createElement('select');
  column.className = 'database-grid-filter-column';
  column.setAttribute('aria-label', t('Filter column'));
  const operator = document.createElement('select');
  operator.className = 'database-grid-filter-operator';
  operator.setAttribute('aria-label', t('Filter operator'));
  const value = document.createElement('input');
  value.className = 'database-grid-filter-value';
  value.type = 'text';
  value.placeholder = t('Filter value');
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn database-grid-filter-add';
  add.textContent = t('Add filter');
  filter.append(column, operator, value, add);

  const chips = el('div', 'database-grid-filter-chips');
  toolbar.append(titleWrap, filter, chips);

  const scroll = el('div', 'database-grid-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', t('Table data grid'));
  const table = document.createElement('table');
  table.className = 'database-data-grid';
  table.append(document.createElement('colgroup'));
  const thead = document.createElement('thead');
  thead.append(document.createElement('tr'));
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  scroll.append(table);
  const bodyShell = el('div', 'database-grid-body');
  const inspector = el('aside', 'database-row-inspector');
  inspector.hidden = true;
  bodyShell.append(scroll, inspector);

  const footer = el('div', 'database-grid-footer');
  const status = el('p', 'database-grid-status');
  const pager = el('div', 'database-grid-pager');
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'btn database-grid-prev';
  previous.textContent = t('Previous');
  const page = el('span', 'database-grid-page', () => t('Page {0}', [1]));
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'btn database-grid-next';
  next.textContent = t('Next');
  pager.append(previous, page, next);
  footer.append(status, editActions, pager);

  mount.replaceChildren(toolbar, bodyShell, footer);
  mount.classList.add('database-grid-host');
  applyDensity(mount, state);

  scroll.addEventListener('scroll', () => renderGridRows(mount, state));
  scroll.addEventListener('keydown', event => {
    if (event.shiftKey && event.key === '+') {
      const rowIndex = state.focusedCell?.rowIndex;
      event.preventDefault();
      if (rowIndex === undefined) {
        setStatus(mount, t('Select a cell first, then press Shift++ to ask ChatGPT about that row.'), true);
        return;
      }
      if (!state.selectedRows.has(rowIndex)) toggleContextRow(mount, state, rowIndex);
      requestChatForDatabaseContext();
      return;
    }
    if (event.key === 'Enter' && !(event.ctrlKey || event.metaKey)) {
      const target = event.target instanceof window.Element
        ? event.target.closest<HTMLTableCellElement>('td[data-row-index][data-column-index]')
        : null;
      if (target) {
        event.preventDefault();
        beginCellEdit(mount, state, target, Number(target.dataset.rowIndex), Number(target.dataset.columnIndex));
      }
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLocaleLowerCase();
    if (key === 'a') {
      if (!state.page) return;
      event.preventDefault();
      state.allCellsSelected = true;
      state.focusedCell = undefined;
      updateCellSelectionVisuals(mount, state);
      setStatus(mount, t('{0} rows selected · Ctrl+C to copy with headers.', [state.page.rows.length]));
    } else if (key === 'c') {
      if (!state.allCellsSelected && !state.focusedCell) return;
      event.preventDefault();
      void copyGridSelection(mount, state);
    }
  });
  density.addEventListener('change', () => {
    state.density = density.value as GridDensity;
    applyDensity(mount, state);
  });
  columnsSearch.addEventListener('input', () => {
    const query = columnsSearch.value.trim().toLocaleLowerCase();
    columnsList.querySelectorAll<HTMLElement>('.database-grid-column-option').forEach(option => {
      option.hidden = Boolean(query) && !option.textContent?.toLocaleLowerCase().includes(query);
    });
  });
  rowDetails.addEventListener('click', () => {
    state.inspectorOpen = !state.inspectorOpen;
    rowDetails.setAttribute('aria-pressed', String(state.inspectorOpen));
    rowDetails.classList.toggle('is-active', state.inspectorOpen);
    renderRowInspector(mount, state);
  });
  column.addEventListener('change', () => configureFilterOperators(mount, state));
  operator.addEventListener('change', () => { value.disabled = operator.value === 'is_null'; });
  add.addEventListener('click', () => {
    if (!allowGridNavigation(mount, state)) return;
    if (!state.page) return;
    const selectedColumn = state.page.columns.find(item => item.name === column.value);
    if (!selectedColumn) return;
    const selectedOperator = operator.value as DatabaseTableFilterOperator;
    try {
      const nextFilter: DatabaseTableFilter = {
        column: selectedColumn.name,
        operator: selectedOperator,
        ...(selectedOperator === 'is_null' ? {} : { value: parseFilterValue(selectedColumn, value.value) })
      };
      state.filters.push(nextFilter);
      value.value = '';
      resetPaging(state);
      renderFilterChips(mount, state);
      void loadCurrentPage(mount, state);
    } catch (error) {
      setStatus(mount, error instanceof Error ? error.message : String(error), true);
    }
  });
  value.addEventListener('keydown', event => {
    if (event.key === 'Enter') add.click();
  });
  previous.addEventListener('click', () => {
    if (!allowGridNavigation(mount, state)) return;
    if (state.pageIndex === 0) return;
    state.pageIndex -= 1;
    void loadCurrentPage(mount, state);
  });
  next.addEventListener('click', () => {
    if (!allowGridNavigation(mount, state)) return;
    if (!state.page?.nextCursor) return;
    state.pageIndex += 1;
    void loadCurrentPage(mount, state);
  });
  saveEdit.addEventListener('click', () => void savePendingEdit(mount, state));
  revertEdit.addEventListener('click', () => {
    if (state.savingEdit) return;
    state.pendingEdit = undefined;
    renderGridRows(mount, state);
    updateEditActions(mount, state);
    setStatus(mount, t('Pending change reverted.'));
  });
}

export function openDatabaseTableGrid(mount: HTMLElement, connection: string, object: DatabaseObjectSummary, accessMode: DatabaseAccessMode): void {
  const state: GridState = {
    connection,
    object,
    accessMode,
    page: null,
    pageStarts: [undefined],
    pageIndex: 0,
    filters: [],
    selectedRows: new Set(),
    columnWidths: new Map(),
    hiddenColumns: new Set(),
    density: 'normal',
    inspectorOpen: false,
    allCellsSelected: false,
    savingEdit: false,
    generation: 0
  };
  activeState = state;
  activeMount = mount;
  buildGrid(mount, state);
  void loadCurrentPage(mount, state);
}

export function clearDatabaseTableSharedRows(): void {
  if (!activeState || !activeMount) return;
  activeState.selectedRows.clear();
  renderGridRows(activeMount, activeState);
  publishGridContext(activeMount, activeState);
  setStatus(activeMount, t('Cleared rows for ChatGPT.'));
}

export function closeDatabaseTableGrid(): void {
  if (activeState) activeState.generation += 1;
  activeState = null;
  activeMount = null;
}

