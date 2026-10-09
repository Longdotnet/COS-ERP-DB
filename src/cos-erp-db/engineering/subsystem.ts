import { initEngineeringStore } from './store.js';
import { initEngineeringPerformance } from './performance.js';

export function initEngineeringSubsystem(userDataDir: string): void {
  initEngineeringStore(userDataDir);
  initEngineeringPerformance(userDataDir);
}
