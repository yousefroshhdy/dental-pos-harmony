import "server-only";
import { headers } from "next/headers";

/** Correlation id for logs and error references (Vercel provides x-vercel-id). */
export async function getRequestId(): Promise<string> {
  const h = await headers();
  return h.get("x-request-id") ?? h.get("x-vercel-id") ?? crypto.randomUUID();
}
