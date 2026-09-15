import type { AppApi } from '../../preload/index.js';
import { run } from '../../renderer/dom.js';

const api = (window as Window & { api: AppApi }).api;

/** Database UI clipboard path. Always uses Electron's native clipboard IPC, never the browser Clipboard API. */
export async function copyDatabaseText(text: string): Promise<boolean> {
  const result = await run(api.writeClipboard(text));
  return result === true;
}
