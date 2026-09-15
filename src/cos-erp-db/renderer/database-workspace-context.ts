import type { AppApi } from '../../preload/index.js';
import type { DatabaseWorkspaceContextInput } from '../../shared/database.js';

const api = (window as Window & { api: AppApi }).api;

/** Fire-and-forget UI state publication. The main process owns validation/bounds and RAM-only storage. */
export function publishDatabaseWorkspaceContext(context: DatabaseWorkspaceContextInput | null): void {
  void api.setDatabaseWorkspaceContext(context).then(() => undefined, () => undefined);
}
