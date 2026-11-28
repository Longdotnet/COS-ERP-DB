import path from 'node:path';
import { nativePathIdentity } from '../../main/sandbox.js';

// Path identities must have been resolved by the connector sandbox before use.
// A prefix match is insufficient (CRM and CRM6.0 are sibling trees).
export function outsideChangeScope(targets: Iterable<string>, allowedRoots: readonly string[]): string[] {
  const roots = allowedRoots.map(nativePathIdentity);
  return [...targets].filter(target => {
    const identity = nativePathIdentity(target);
    return !roots.some(root => {
      const relative = path.relative(root, identity);
      return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    });
  });
}
