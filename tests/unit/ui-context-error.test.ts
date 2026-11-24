import { beforeEach, describe, expect, it, vi } from "vitest";

// getUserContext() talks to Supabase through createClient(); replace it with a fake
// whose getClaims / rpc results each test sets.
const fake = vi.hoisted(() => ({
  claims: null as { claims: { sub: string } } | null,
  rpc: (async () => ({ data: null, error: null })) as () => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: fake.claims }) },
    rpc: () => fake.rpc(),
  }),
}));
vi.mock("@/lib/log", () => ({ log: () => {} }));

const { getUserContext } = await import("@/lib/authz/context");

const USER = "00000000-0000-4000-8000-0000000000c1";
const ACTIVE = {
  user_id: USER,
  active: true,
  is_owner: false,
  locale: "ar",
  status: "active",
  employee: { id: "e1", employee_no: "E-001", full_name_en: "Test Rep", full_name_ar: null, job_title: "Rep" },
  permissions: { "field.visit.create": { scope: "own", limit: null } },
};

describe("getUserContext error flag", () => {
  beforeEach(() => {
    fake.claims = { claims: { sub: USER } };
  });

  it("no session: anonymous, not an error (the layout redirects to login)", async () => {
    fake.claims = null;
    const ctx = await getUserContext();
    expect(ctx.user_id).toBeNull();
    expect(ctx.error).toBe(false);
  });

  it("my_context() failed: signed in, grants nothing, error is set", async () => {
    fake.rpc = async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    const ctx = await getUserContext();
    expect(ctx).toMatchObject({ user_id: USER, active: false, is_owner: false, permissions: {}, error: true });
  });

  it("my_context() threw (network): same error state", async () => {
    fake.rpc = async () => {
      throw new TypeError("fetch failed");
    };
    const ctx = await getUserContext();
    expect(ctx).toMatchObject({ user_id: USER, active: false, permissions: {}, error: true });
  });

  it("my_context() returned no row: error, not 'inactive'", async () => {
    fake.rpc = async () => ({ data: null, error: null });
    expect((await getUserContext()).error).toBe(true);
  });

  it("loaded: the server's context, error false", async () => {
    fake.rpc = async () => ({ data: ACTIVE, error: null });
    const ctx = await getUserContext();
    expect(ctx).toEqual({ ...ACTIVE, error: false });
  });

  it("a genuinely inactive account is not an error", async () => {
    fake.rpc = async () => ({ data: { ...ACTIVE, active: false, status: "suspended", permissions: {} }, error: null });
    const ctx = await getUserContext();
    expect(ctx.active).toBe(false);
    expect(ctx.error).toBe(false);
  });
});
