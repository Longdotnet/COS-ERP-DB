import {
  COS_ERP_DB_BRIDGE_AUTO_PORTS,
  COS_ERP_DB_BRIDGE_FALLBACK_PORTS,
  COS_ERP_DB_BRIDGE_PORTS
} from '../cos-erp-db/browser-identity.js';

/** Fixed ports offered in Settings by the COS ERP DB fork. */
export const BROWSER_BRIDGE_PORTS = COS_ERP_DB_BRIDGE_PORTS;
/** Auto-only recovery ranges used when Windows reserves the primary block (#1314 upstream). */
export const BROWSER_BRIDGE_FALLBACK_PORTS = COS_ERP_DB_BRIDGE_FALLBACK_PORTS;
/** Auto's order, and exactly the list the extension scans (extension/background.js `PORTS`). */
export const BROWSER_BRIDGE_AUTO_PORTS = COS_ERP_DB_BRIDGE_AUTO_PORTS;
export type BrowserBridgePort = 'auto' | (typeof BROWSER_BRIDGE_PORTS)[number];
