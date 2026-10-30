/**
 * Each Phase 3 module keeps its strings in messages/<locale>/<module>.json and
 * reads them under the `<module>` namespace, so modules never edit a shared file.
 */
export const MESSAGE_MODULES = ["crm", "field", "orders", "inventory", "catalog", "approvals", "offline", "finance", "dashboards", "tracking", "imports", "returns", "commissions", "planning", "workflow", "audit", "reports", "security"] as const;
