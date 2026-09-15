import { initDatabaseCredentials } from './credentials.js';
import { initDatabaseGrowthHistory } from './growth-history.js';
import { initDatabaseStore } from './store.js';

/** One startup hook keeps all fork-owned database persistence under its own userData boundary. */
export function initDatabaseSubsystem(userDataDir: string): void {
  initDatabaseStore(userDataDir);
  initDatabaseCredentials(userDataDir);
  initDatabaseGrowthHistory(userDataDir);
}
