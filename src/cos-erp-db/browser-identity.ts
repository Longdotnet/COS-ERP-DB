/** Browser bridge identity owned by the COS-ERP-DB fork. */
export const COS_ERP_DB_BRIDGE_IDENTITY = 'cos-erp-db';

/**
 * Fork-owned loopback range. Keep it disjoint from upstream Chat On Steroids (8765-8769)
 * so both desktop apps and both companion extensions can run in the same Chrome profile.
 */
export const COS_ERP_DB_BRIDGE_PORTS = [8865, 8866, 8867, 8868, 8869] as const;

/**
 * Auto-only fallback ranges for the fork. They mirror upstream's reserved-port recovery while
 * staying disjoint from Chat On Steroids' 8765/18765/38765 families, so both apps can coexist.
 */
export const COS_ERP_DB_BRIDGE_FALLBACK_PORTS = [
  18865, 18866, 18867, 18868, 18869,
  38865, 38866, 38867, 38868, 38869
] as const;

/** Auto discovery order shared by the app and the COS ERP DB companion extension. */
export const COS_ERP_DB_BRIDGE_AUTO_PORTS = [
  ...COS_ERP_DB_BRIDGE_PORTS,
  ...COS_ERP_DB_BRIDGE_FALLBACK_PORTS
] as const;
