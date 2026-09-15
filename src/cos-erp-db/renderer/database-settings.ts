import type { AppApi } from '../../preload/index.js';
import type { DatabaseProfileDraft, DatabaseSettingsState } from '../../shared/database.js';
import { $, el, icon, run, toast } from '../../renderer/dom.js';
import { ui } from '../../renderer/i18n.js';
import { t } from './i18n.js';
import { initDatabaseExplorer, setDatabaseExplorerState } from './database-explorer.js';
import { initDatabaseGrowthDashboard, setDatabaseGrowthDashboardState } from './database-growth-dashboard.js';

const api = (window as Window & { api: AppApi }).api;

let state: DatabaseSettingsState | null = null;
let editorId: string | null = null;
let drafting = false;
let dirty = false;

function input(id: string, type = 'text', placeholder = ''): HTMLInputElement {
  const node = document.createElement('input');
  node.id = id;
  node.type = type;
  node.spellcheck = false;
  node.autocomplete = type === 'password' ? 'new-password' : 'off';
  if (placeholder) ui(node, 'placeholder', () => t(placeholder));
  return node;
}

function label(forId: string, text: string): HTMLLabelElement {
  const node = document.createElement('label');
  node.htmlFor = forId;
  ui(node, 'textContent', () => t(text));
  return node;
}

function button(id: string, text: string, primary = false): HTMLButtonElement {
  const node = document.createElement('button');
  node.id = id;
  node.type = 'button';
  node.className = primary ? 'btn is-primary' : 'btn';
  ui(node, 'textContent', () => t(text));
  return node;
}

function ensureDatabaseSurface(): HTMLElement {
  let mount = document.getElementById('cosErpDbSettingsMount');
  if (mount) return mount;

  const tabs = $('tabs');
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.dataset.tab = 'database';
  tab.append(icon('i-terminal'), document.createTextNode(t('Databases')));
  const agentsTab = tabs.querySelector<HTMLElement>('[data-tab="settings"]');
  tabs.insertBefore(tab, agentsTab);

  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.dataset.panel = 'database';
  const heading = el('div', 'settings-heading');
  heading.append(
    el('h1', '', () => t('Databases')),
    el('p', '', () => t('Manage SQL Server connections used by the Core database tool.'))
  );
  mount = document.createElement('div');
  mount.id = 'cosErpDbSettingsMount';
  panel.append(heading, mount);
  document.querySelector('main')!.append(panel);
  return mount;
}

function buildDatabaseSettings(): void {
  const mount = ensureDatabaseSurface();
  if (mount.childElementCount > 0) return;

  const pane = el('div', 'pane');
  pane.classList.add('database-settings-pane');
  const growthMount = el('div', 'database-growth-mount');
  const explorerMount = el('div', 'database-explorer-mount');
  const row = el('div', 'database-connections-head');
  const text = el('span', 'setting-text');
  text.append(el('b', '', () => t('SQL Server connections')), el('em', '', () => t('Stored locally. ChatGPT can use the Core database tool for read-only queries.')));
  row.append(text, button('databaseAdd', 'Add SQL Server', true));

  const profileList = el('div', 'database-profile-list');
  profileList.id = 'databaseProfileList';
  ui(profileList, 'aria-label', () => t('Saved SQL Server connections'));

  const editor = el('div', 'field');
  editor.id = 'databaseEditor';
  editor.classList.add('database-editor');
  const editorHead = el('div', 'database-editor-head');
  const editorTitle = el('h2');
  editorTitle.id = 'databaseEditorTitle';
  const editorHelp = el('p', '', () => t('Fill in the connection details, then save or test the connection.'));
  editorHead.append(editorTitle, editorHelp);
  const name = input('databaseName', 'text', 'LinkQ Test');
  const server = input('databaseServer', 'text', 'localhost or sqlserver.company.local');
  const serverHint = el('p', 'hint', () => t('If SSMS shows server,port, put the host in Server and the number in Port.'));
  const database = input('databaseNameValue', 'text', 'L80LINKQ.TEST');
  const authentication = document.createElement('select');
  authentication.id = 'databaseAuthentication';
  for (const [value, textValue] of [['sql', 'SQL Server Authentication'], ['ntlm', 'NTLM / Windows credentials']] as const) {
    const option = document.createElement('option');
    option.value = value;
    ui(option, 'textContent', () => t(textValue));
    authentication.append(option);
  }
  const user = input('databaseUser');
  const domainField = document.createElement('div');
  domainField.id = 'databaseDomainField';
  const domain = input('databaseDomain');
  domainField.append(label('databaseDomain', 'Domain'), domain);
  const password = input('databasePassword', 'password', 'Enter password');
  const passwordState = el('p', 'hint');
  passwordState.id = 'databasePasswordState';
  const port = input('databasePort', 'number', '1433 (optional)');
  port.className = 'num';
  port.min = '1'; port.max = '65535'; port.step = '1';
  const instanceName = input('databaseInstance', 'text', 'Optional, e.g. SQLEXPRESS');

  const accessMode = document.createElement('select');
  accessMode.id = 'databaseAccessMode';
  for (const [value, textValue] of [['read-only', 'Read-only'], ['full-access', 'Full access']] as const) {
    const option = document.createElement('option');
    option.value = value;
    ui(option, 'textContent', () => t(textValue));
    accessMode.append(option);
  }
  const accessModeHint = el('p', 'hint');
  accessModeHint.id = 'databaseAccessModeHint';

  const encryptRow = document.createElement('label');
  encryptRow.className = 'setting';
  const encryptText = el('span', 'setting-text');
  encryptText.append(
    el('b', '', () => t('Encrypt connection')),
    el('em', '', () => t('Use TLS for traffic between this app and SQL Server. Recommended for new connections.'))
  );
  const encryptInput = input('databaseEncrypt', 'checkbox');
  encryptRow.append(encryptText, encryptInput);

  const trustRow = document.createElement('label');
  trustRow.className = 'setting';
  const trustText = el('span', 'setting-text');
  trustText.append(
    el('b', '', () => t('Trust server certificate')),
    el('em', '', () => t('Skip certificate-chain validation. Use only for servers whose certificate you trust another way.'))
  );
  const trustInput = input('databaseTrustServerCertificate', 'checkbox');
  trustRow.append(trustText, trustInput);

  const defaultRow = document.createElement('label');
  defaultRow.className = 'setting';
  const defaultText = el('span', 'setting-text');
  defaultText.append(el('b', '', () => t('Default connection')), el('em', '', () => t('Used when the model omits the connection id.')));
  const defaultInput = input('databaseDefault', 'checkbox');
  defaultRow.append(defaultText, defaultInput);

  const status = el('p', 'hint');
  status.id = 'databaseStatus';
  status.setAttribute('role', 'status');
  const actions = el('div', 'step-actions');
  actions.append(button('databaseTest', 'Test Connection'), button('databaseSave', 'Save', true), button('databaseRemove', 'Remove'));

  editor.append(
    editorHead,
    label('databaseName', 'Name'), name,
    label('databaseServer', 'Server'), server, serverHint,
    label('databaseNameValue', 'Database'), database,
    label('databaseAuthentication', 'Authentication'), authentication,
    label('databaseUser', 'User'), user,
    domainField,
    label('databasePassword', 'Password'), password, passwordState,
    label('databasePort', 'Port'), port,
    label('databaseInstance', 'Instance name'), instanceName,
    label('databaseAccessMode', 'Database access'), accessMode, accessModeHint,
    encryptRow, trustRow,
    defaultRow, status, actions
  );
  pane.append(growthMount, explorerMount, row, profileList, editor);
  mount.append(pane);
  initDatabaseGrowthDashboard(growthMount);
  initDatabaseExplorer(explorerMount);
}

function authenticationFields(): void {
  $('databaseDomainField').hidden = $<HTMLSelectElement>('databaseAuthentication').value !== 'ntlm';
}

function accessModeHelp(): void {
  const mode = $<HTMLSelectElement>('databaseAccessMode').value;
  const hint = $('databaseAccessModeHint');
  ui(hint, 'textContent', () => mode === 'full-access'
    ? t('Full access enables guarded inline cell editing in Object Explorer. ChatGPT database queries remain read-only and raw SQL writes are not exposed.')
    : t('The database tool is read-only for this profile. For production, also use a SQL Server login with SELECT-only permissions so the database itself enforces the boundary.'));
  hint.classList.toggle('is-warn', mode === 'full-access');
}

function setValue(id: string, value: string): void {
  const control = $<HTMLInputElement | HTMLSelectElement>(id);
  if (document.activeElement !== control || !dirty) control.value = value;
}

function connectionEndpoint(profile: DatabaseSettingsState['settings']['connections'][number]): string {
  if (profile.port !== undefined) return `${profile.server},${profile.port}`;
  if (profile.instanceName) return `${profile.server}\\${profile.instanceName}`;
  return profile.server;
}

function renderProfileList(next: DatabaseSettingsState, selectedId: string | null, creating: boolean): void {
  const list = $('databaseProfileList');
  const cards: HTMLElement[] = [];

  if (creating) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'database-profile-card is-active is-draft';
    card.dataset.profileId = '';
    card.setAttribute('aria-pressed', 'true');
    const copy = el('span', 'database-profile-copy');
    copy.append(el('strong', '', () => t('New SQL Server connection')), el('small', '', () => t('Fill in the details below to create a connection.')));
    const badges = el('span', 'database-profile-badges');
    badges.append(el('span', 'database-profile-badge is-draft', () => t('Not saved yet')));
    card.append(copy, badges);
    cards.push(card);
  }

  for (const profile of next.settings.connections) {
    const card = document.createElement('button');
    const selected = !creating && profile.id === selectedId;
    card.type = 'button';
    card.className = `database-profile-card${selected ? ' is-active' : ''}`;
    card.dataset.profileId = profile.id;
    card.setAttribute('aria-pressed', String(selected));
    const copy = el('span', 'database-profile-copy');
    const meta = el('small');
    meta.textContent = `${connectionEndpoint(profile)} · ${profile.database}`;
    copy.append(el('strong', '', profile.name), meta);
    const badges = el('span', 'database-profile-badges');
    if (next.settings.defaultConnectionId === profile.id) badges.append(el('span', 'database-profile-badge is-default', () => t('Default')));
    badges.append(el('span', `database-profile-badge ${profile.accessMode === 'full-access' ? 'is-full-access' : 'is-read-only'}`, () => t(profile.accessMode === 'full-access' ? 'Full access' : 'Read-only')));
    if (next.passwordStored[profile.id]) badges.append(el('span', 'database-profile-badge is-password', () => t('Password saved')));
    card.append(copy, badges);
    cards.push(card);
  }

  list.replaceChildren(...cards);
}

function loadEditor(next: DatabaseSettingsState): void {
  setDatabaseGrowthDashboardState(next);
  setDatabaseExplorerState(next);
  const profiles = next.settings.connections;
  if (!drafting && (!editorId || !profiles.some(profile => profile.id === editorId))) {
    editorId = next.settings.defaultConnectionId ?? profiles[0]?.id ?? null;
  }
  const profile = drafting ? undefined : profiles.find(candidate => candidate.id === editorId);
  if (!dirty) {
    setValue('databaseName', profile?.name ?? '');
    setValue('databaseServer', profile?.server ?? '');
    setValue('databaseNameValue', profile?.database ?? '');
    setValue('databaseAuthentication', profile?.authentication.type ?? 'sql');
    setValue('databaseUser', profile?.authentication.user ?? '');
    setValue('databaseDomain', profile?.authentication.type === 'ntlm' ? profile.authentication.domain : '');
    setValue('databasePort', profile?.port === undefined ? '' : String(profile.port));
    setValue('databaseInstance', profile?.instanceName ?? '');
    setValue('databaseAccessMode', profile?.accessMode ?? 'read-only');
    $<HTMLInputElement>('databaseEncrypt').checked = profile?.encrypt ?? true;
    $<HTMLInputElement>('databaseTrustServerCertificate').checked = profile?.trustServerCertificate ?? false;
    $<HTMLInputElement>('databaseDefault').checked = profile
      ? next.settings.defaultConnectionId === profile.id
      : profiles.length === 0;
    $<HTMLInputElement>('databasePassword').value = '';
  }
  authenticationFields();
  accessModeHelp();

  const creating = drafting || !profile;
  renderProfileList(next, editorId, creating);
  ui($('databaseEditorTitle'), 'textContent', () => creating ? t('New SQL Server connection') : profile!.name);

  const secure = next.secureStorage.available;
  const passwordStored = profile ? next.passwordStored[profile.id] === true : false;
  const password = $<HTMLInputElement>('databasePassword');
  ui(password, 'placeholder', () => passwordStored ? t('•••••••• stored') : t('Enter password'));
  password.disabled = !secure;
  ui($('databasePasswordState'), 'textContent', () => !secure
    ? (next.secureStorage.detail ?? t('Secure credential storage is unavailable.'))
    : passwordStored
      ? t('A password is stored with secure OS credential storage. Type a new one to replace it.')
      : t('The password is stored only in secure OS credential storage and is never returned to ChatGPT.'));
  $('databasePasswordState').classList.toggle('is-warn', !secure);
  $<HTMLButtonElement>('databaseRemove').disabled = !profile;
  $<HTMLButtonElement>('databaseTest').disabled = !secure;
}

function draft(): DatabaseProfileDraft | null {
  const name = $<HTMLInputElement>('databaseName').value.trim();
  const server = $<HTMLInputElement>('databaseServer').value.trim();
  const database = $<HTMLInputElement>('databaseNameValue').value.trim();
  const user = $<HTMLInputElement>('databaseUser').value.trim();
  const auth = $<HTMLSelectElement>('databaseAuthentication').value as 'sql' | 'ntlm';
  const domain = $<HTMLInputElement>('databaseDomain').value.trim();
  const portText = $<HTMLInputElement>('databasePort').value.trim();
  const instanceName = $<HTMLInputElement>('databaseInstance').value.trim();
  const accessMode = $<HTMLSelectElement>('databaseAccessMode').value as 'read-only' | 'full-access';
  if (!name || !server || !database || !user || (auth === 'ntlm' && !domain)) {
    toast(t('Name, server, database and user are required. NTLM also requires a domain.'));
    return null;
  }
  if (portText && instanceName) {
    toast(t('Use either port or instance name, not both.'));
    return null;
  }
  const port = portText ? Number(portText) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    toast(t('Port must be between 1 and 65535.'));
    return null;
  }
  return {
    ...(editorId ? { id: editorId } : {}),
    name,
    server,
    database,
    ...(port === undefined ? {} : { port }),
    ...(instanceName ? { instanceName } : {}),
    accessMode,
    encrypt: $<HTMLInputElement>('databaseEncrypt').checked,
    trustServerCertificate: $<HTMLInputElement>('databaseTrustServerCertificate').checked,
    authentication: auth === 'sql' ? { type: 'sql', user } : { type: 'ntlm', user, domain },
    makeDefault: $<HTMLInputElement>('databaseDefault').checked
  };
}

async function saveEditor(showToast = true): Promise<string | null> {
  const input = draft();
  if (!input) return null;
  const submittedPassword = $<HTMLInputElement>('databasePassword').value;
  const saved = await run(api.saveDatabaseProfile(input, submittedPassword === '' ? undefined : submittedPassword));
  if (!saved) return null;
  editorId = saved.profileId;
  drafting = false;
  dirty = false;
  state = saved.state;
  loadEditor(saved.state);
  if (submittedPassword !== '' && $<HTMLInputElement>('databasePassword').value === submittedPassword) {
    $<HTMLInputElement>('databasePassword').value = '';
  }
  if (showToast) toast(t('Database connection saved'));
  return saved.profileId;
}

function wire(): void {
  for (const id of [
    'databaseName', 'databaseServer', 'databaseNameValue', 'databaseAuthentication', 'databaseUser',
    'databaseDomain', 'databasePassword', 'databasePort', 'databaseInstance', 'databaseEncrypt',
    'databaseTrustServerCertificate', 'databaseAccessMode', 'databaseDefault'
  ]) {
    for (const eventName of ['input', 'change']) $(id).addEventListener(eventName, () => {
      dirty = true;
      if (id === 'databaseAuthentication') authenticationFields();
      if (id === 'databaseAccessMode') accessModeHelp();
    });
  }
  $('databaseProfileList').addEventListener('click', event => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>('.database-profile-card');
    if (!card) return;
    editorId = card.dataset.profileId || null;
    drafting = editorId === null;
    dirty = false;
    if (state) loadEditor(state);
  });
  $('databaseAdd').addEventListener('click', () => {
    editorId = null;
    drafting = true;
    dirty = false;
    ui($('databaseStatus'), 'textContent', () => '');
    if (state) loadEditor(state);
    $<HTMLInputElement>('databaseName').focus();
  });
  $('databaseSave').addEventListener('click', () => void saveEditor(true));
  $('databaseTest').addEventListener('click', async () => {
    const id = await saveEditor(false);
    if (!id) return;
    ui($('databaseStatus'), 'textContent', () => t('Testing connection…'));
    const tested = await run(api.testDatabaseConnection(id));
    if (!tested) {
      ui($('databaseStatus'), 'textContent', () => t('Connection test failed.'));
      return;
    }
    ui($('databaseStatus'), 'textContent', () => t('Connected to {0} in {1} ms.', [tested.database, tested.elapsedMs]));
    toast(t('Database connection succeeded'));
  });
  $('databaseRemove').addEventListener('click', async () => {
    if (!editorId) return;
    const next = await run(api.removeDatabaseProfile(editorId));
    if (!next) return;
    editorId = null;
    drafting = false;
    dirty = false;
    state = next;
    loadEditor(next);
    toast(t('Database connection removed'));
  });
}

export function initDatabaseSettings(): void {
  buildDatabaseSettings();
  wire();
  void run(api.getDatabaseState()).then(next => {
    if (!next) return;
    state = next;
    loadEditor(next);
  });
}
