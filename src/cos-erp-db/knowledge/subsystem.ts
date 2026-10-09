import { initKnowledgeStore } from './store.js';
import { initBusinessProcessStore } from './process-store.js';
import { initIncidentPatternStore } from './pattern-store.js';
import { initIncidentOutcomeStore } from './outcome-store.js';

export function initKnowledgeSubsystem(userDataDir: string): void {
  initKnowledgeStore(userDataDir);
  initBusinessProcessStore(userDataDir);
  initIncidentOutcomeStore(userDataDir);
  initIncidentPatternStore(userDataDir);
}
