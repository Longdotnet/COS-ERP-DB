import { initDatabaseSubsystem } from '../../main/database/subsystem.js';
import { stopAllIncidentWatches } from '../../main/database/incident-watch.js';
import { closeSqlServerPools } from '../../main/database/sqlserver.js';
import { initEngineeringSubsystem } from '../engineering/subsystem.js';
import { initKnowledgeSubsystem } from '../knowledge/subsystem.js';

export function initCosErpDbSubsystems(userDataDir: string): void {
  initDatabaseSubsystem(userDataDir);
  initKnowledgeSubsystem(userDataDir);
  initEngineeringSubsystem(userDataDir);
}

export async function stopCosErpDbBackgroundWork(): Promise<void> {
  await stopAllIncidentWatches();
}

export function closeCosErpDbResources(): Promise<void> {
  return closeSqlServerPools();
}
