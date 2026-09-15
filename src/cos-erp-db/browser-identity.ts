/** Browser bridge identity owned by the COS-ERP-DB fork. */
export const COS_ERP_DB_BRIDGE_IDENTITY = 'cos-erp-db';

/**
 * Fork-owned loopback range. Keep it disjoint from upstream Chat On Steroids (8765-8769)
 * so both desktop apps and both companion extensions can run in the same Chrome profile.
 */
export const COS_ERP_DB_BRIDGE_PORTS = [8865, 8866, 8867, 8868, 8869] as const;
