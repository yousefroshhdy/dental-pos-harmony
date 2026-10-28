import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness probe for uptime monitors. Reveals no configuration or data. */
export function GET() {
  return NextResponse.json({ status: "ok", time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
