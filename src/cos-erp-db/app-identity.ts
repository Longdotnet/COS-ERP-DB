import { existsSync } from 'node:fs';
import path from 'node:path';

export interface AppIdentityHost {
  readonly isPackaged: boolean;
  getPath(name: 'appData'): string;
  setName(name: string): void;
  setPath(name: 'userData', value: string): void;
  setAppUserModelId?(id: string): void;
}

export interface CosErpDbIdentity {
  displayName: string;
  appId: string;
  userData: string;
  development: boolean;
}

function prependPath(dir: string): void {
  const current = process.env.PATH ?? process.env.Path ?? '';
  const entries = current.split(path.delimiter).filter(Boolean);
  if (entries.some(entry => entry.toLowerCase() === dir.toLowerCase())) return;
  process.env.PATH = [dir, ...entries].join(path.delimiter);
}

/**
 * Dev does not run electron-builder's extraResources step. When the installed upstream app is
 * present, reuse only its tunnel executable directory; COS-ERP-DB still keeps config, secrets,
 * sessions and userData completely separate. Packaged COS-ERP-DB ships its own tunnel binary.
 */
export function configureDevelopmentTunnelFallback(development: boolean): string | null {
  if (!development || process.platform !== 'win32') return null;
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const dir = path.join(programFiles, 'Chat On Steroids', 'resources', 'tunnel');
  if (!existsSync(path.join(dir, 'tunnel-client.exe'))) return null;
  prependPath(dir);
  return dir;
}

/**
 * Give the fork its own process identity before Electron takes the single-instance lock.
 *
 * The upstream app is commonly running at the same time because it is the bridge used to work
 * on this fork. A distinct userData path also keeps config, secrets, sessions and update staging
 * completely separate from the installed upstream app.
 */
export function configureCosErpDbIdentity(host: AppIdentityHost): CosErpDbIdentity {
  const development = !host.isPackaged;
  const displayName = development ? 'COS ERP DB Dev' : 'COS ERP DB';
  const appId = development ? 'com.longdotnet.cos-erp-db.dev' : 'com.longdotnet.cos-erp-db';
  const userData = path.join(host.getPath('appData'), development ? 'COS-ERP-DB-Dev' : 'COS-ERP-DB');

  host.setName(displayName);
  host.setPath('userData', userData);
  host.setAppUserModelId?.(appId);
  configureDevelopmentTunnelFallback(development);
  return { displayName, appId, userData, development };
}

/** Fork releases are merged from upstream source; never install an upstream COS binary over this fork. */
export const COS_ERP_DB_AUTO_UPDATE = false;
