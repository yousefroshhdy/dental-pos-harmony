import { z } from "zod";

/**
 * Environment contract. Values are validated on first use (not at import) so
 * `next build` works in CI without real credentials; a missing value fails the
 * first request with a clear message instead of an obscure Supabase error.
 *
 * NEXT_PUBLIC_* values are safe for the browser (the anon key is public by
 * design; RLS protects data). Everything else is server-only.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  CRON_SECRET: z.string().min(32),
  OUTBOX_SIGNING_SECRET: z.string().min(32),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

function format(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

let cachedPublic: PublicEnv | undefined;
export function publicEnv(): PublicEnv {
  if (cachedPublic) return cachedPublic;
  // Next.js inlines NEXT_PUBLIC_* only when referenced literally.
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
  if (!parsed.success) throw new Error(`Invalid public environment: ${format(parsed.error)}`);
  cachedPublic = parsed.data;
  return cachedPublic;
}

let cachedServer: ServerEnv | undefined;
export function serverEnv(): ServerEnv {
  if (typeof window !== "undefined") throw new Error("serverEnv() must never run in the browser");
  if (cachedServer) return cachedServer;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid server environment: ${format(parsed.error)}`);
  cachedServer = parsed.data;
  return cachedServer;
}
