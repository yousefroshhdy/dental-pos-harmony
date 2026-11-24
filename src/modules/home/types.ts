/** Read shapes for the role homes (api.* views; numeric columns may arrive as strings). */
type Numeric = number | string | null;

/** api.v_my_today (visits only are used by the plan card). */
export interface PlanItem {
  item_type: "task" | "visit";
  item_id: string;
  title: string;
  status: string;
  customer_id: string | null;
  customer_name: string | null;
  due_at: string | null;
  planned_for: string | null;
  is_overdue: boolean;
}

/** api.v_visits, today's visits of one employee. */
export interface VisitToday {
  id: string;
  customer_id: string;
  customer_name: string | null;
  status: string;
  check_in_at: string | null;
  check_out_at: string | null;
  verification_status: string;
}

/** api.v_payments, today's receipts. */
export interface ReceiptRow {
  id: string;
  amount: Numeric;
  status: string;
  method: string;
}

/** api.v_ar_aging_totals */
export interface AgingTotals {
  customers: number;
  current_amount: Numeric;
  d1_30: Numeric;
  d31_60: Numeric;
  d61_90: Numeric;
  d90_plus: Numeric;
  total_open: Numeric;
  overdue_amount: Numeric;
}

/** api.v_opportunities (open ones). */
export interface OpportunityLite {
  stage: string;
  expected_value: Numeric;
}
