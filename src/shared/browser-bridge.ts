import { COS_ERP_DB_BRIDGE_PORTS } from '../cos-erp-db/browser-identity.js';

/** Ports discoverable by the COS ERP DB companion extension without additional host permissions. */
export const BROWSER_BRIDGE_PORTS = COS_ERP_DB_BRIDGE_PORTS;
export type BrowserBridgePort = 'auto' | (typeof BROWSER_BRIDGE_PORTS)[number];
