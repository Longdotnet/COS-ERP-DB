import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configureCosErpDbIdentity } from '../src/cos-erp-db/app-identity.js';
import { surfaceDefinition } from '../src/main/mcp/surfaces.js';

describe('COS-ERP-DB Electron identity', () => {
  it.each([
    [false, 'COS ERP DB Dev', 'com.longdotnet.cos-erp-db.dev', 'COS-ERP-DB-Dev'],
    [true, 'COS ERP DB', 'com.longdotnet.cos-erp-db', 'COS-ERP-DB']
  ] as const)('isolates packaged=%s from upstream process and userData', (isPackaged, displayName, appId, folder) => {
    const setName = vi.fn();
    const setPath = vi.fn();
    const setAppUserModelId = vi.fn();
    const identity = configureCosErpDbIdentity({
      isPackaged,
      getPath: () => path.join('C:', 'Users', 'tester', 'AppData', 'Roaming'),
      setName,
      setPath,
      setAppUserModelId
    });
    expect(identity).toMatchObject({ displayName, appId, development: !isPackaged });
    expect(identity.userData).toBe(path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', folder));
    expect(setName).toHaveBeenCalledWith(displayName);
    expect(setPath).toHaveBeenCalledWith('userData', identity.userData);
    expect(setAppUserModelId).toHaveBeenCalledWith(appId);
  });

  it('keeps the ChatGPT connector names distinct from an installed upstream app', () => {
    expect(surfaceDefinition('core').connectorName).toBe('COS ERP DB Core');
    expect(surfaceDefinition('desktop').connectorName).toBe('COS ERP DB Desktop');
    expect(surfaceDefinition('plugins').connectorName).toBe('COS ERP DB Plugins');

    // Server names are protocol/cache identities inherited from upstream. The custom-app
    // labels are what distinguish two side-by-side installations in ChatGPT.
    expect(surfaceDefinition('core').serverName).toBe('chat-on-steroids-core');
  });
});
