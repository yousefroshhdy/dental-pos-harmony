"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardTitle, Input, Label, Select } from "@/components/ui/primitives";
import { Link, useRouter } from "@/i18n/navigation";
import type { QueueItem } from "@/lib/offline/types";
import { useOfflineQueue } from "@/modules/offline/use-offline-queue";
import { saveDraftOnDevice, searchVariants } from "../actions";
import { loadDraft, removeLocalDraft, saveLocalDraft } from "../device-store";
import { CAIRO_DATE_TIME } from "../format";
import { addLine, localizedName, MAX_LINES, MAX_QUANTITY, sanitizeSearch, type OrderErrorCode } from "../logic";
import {
  buildDraftPayload,
  canSaveDraft,
  chooseBuilderStart,
  draftItems,
  draftQueueState,
  indicativeTotals,
  NEW_SLOT,
  nextBaseVersion,
  priceMap,
  searchCatalog,
  submitOrderDraft,
  syncedVersion,
  type BuilderSeed,
  type CatalogSnapshot,
  type RestoreNotice,
} from "../offline-logic";
import type { BuilderLine, CustomerOption, SellableVariant } from "../types";
import { useCatalogSnapshot, useOrdersDeviceStart } from "../use-order-device";
import { OrderError } from "./order-error";

export interface BuilderInitial {
  /** Set when editing an existing draft. */
  orderId?: string;
  version?: number;
  customerId?: string;
  visitId?: string;
  notes?: string;
  lines?: BuilderLine[];
}

const SEARCH_DELAY_MS = 300;

/**
 * Order builder. The browser holds only variant ids and quantities; it never
 * sends a price. It shows indicative list prices from the last online catalogue
 * snapshot, labelled as such; the server prices the saved draft.
 *
 * Offline (docs/ARCHITECTURE.md §6, A-05): the lines are kept on this device,
 * "Save draft" goes to the device queue and is sent when the connection returns
 * (api.save_order_draft, replay-safe by order id + base version). Submitting
 * needs a connection and happens on the order page.
 */
export function OrderBuilder({
  customers,
  initial,
  locale,
  userId,
}: {
  customers: CustomerOption[];
  initial: BuilderInitial;
  locale: string;
  userId: string;
}) {
  const t = useTranslations("orders.builder");
  const tOffline = useTranslations("orders.offline");
  const format = useFormatter();
  const router = useRouter();
  const ids = { customer: useId(), filter: useId(), search: useId(), notes: useId(), results: useId(), offline: useId() };
  useOrdersDeviceStart(userId);
  const { engine, items, online } = useOfflineQueue(userId);
  const catalog = useCatalogSnapshot(userId, online);

  const slot = initial.orderId ?? NEW_SLOT;
  const serverSeed = useMemo<BuilderSeed>(
    () => ({
      orderId: initial.orderId ?? null,
      serverVersion: initial.version ?? 0,
      // Only a customer the user may still sell to can be preselected.
      customerId: initial.customerId && customers.some((c) => c.id === initial.customerId) ? initial.customerId : "",
      visitId: initial.visitId ?? null,
      notes: initial.notes ?? "",
      lines: initial.lines ?? [],
    }),
    [initial, customers],
  );

  const [seed, setSeed] = useState<BuilderSeed>(serverSeed);
  const [customerId, setCustomerId] = useState(serverSeed.customerId);
  const [customerFilter, setCustomerFilter] = useState("");
  const [lines, setLines] = useState<BuilderLine[]>(serverSeed.lines);
  const [notes, setNotes] = useState(serverSeed.notes);
  const [dirty, setDirty] = useState(false);
  const [restored, setRestored] = useState(false);
  const [notice, setNotice] = useState<RestoreNotice>("none");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: OrderErrorCode; requestId?: string } | null>(null);
  const leaving = useRef(false);

  // The device copy, once per mount, after the queue was read (it decides whether the copy has unsent work).
  useEffect(() => {
    let alive = true;
    const restore = async (queueItems: QueueItem[]) => {
      if (!alive) return;
      const local = loadDraft(userId, slot);
      const mine = draftItems(queueItems, local?.orderId ?? serverSeed.orderId);
      const known = local ? { ...local, serverVersion: Math.max(local.serverVersion, syncedVersion(mine)) } : null;
      const start = chooseBuilderStart(slot, known, serverSeed, mine.filter((i) => i.status !== "done").length);
      if (start.dropLocal) removeLocalDraft(userId, slot);
      if (start.seed !== serverSeed) {
        const keep = start.seed.customerId && customers.some((c) => c.id === start.seed.customerId);
        setSeed(start.seed);
        setCustomerId(keep ? start.seed.customerId : "");
        setLines(start.seed.lines);
        setNotes(start.seed.notes);
        setDirty(known?.dirty ?? false);
      }
      setNotice(start.notice);
      setRestored(true);
    };
    if (!engine) {
      void restore([]);
    } else {
      engine.list().then(restore, () => restore([]));
    }
    return () => {
      alive = false;
    };
    // Runs once per builder (slot); later queue changes are shown, not restored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, slot]);

  const mine = useMemo(() => draftItems(items, seed.orderId), [items, seed.orderId]);
  const serverVersion = Math.max(seed.serverVersion, syncedVersion(mine));
  const queueState = draftQueueState(mine);
  const prices = useMemo(() => priceMap(catalog.snapshot), [catalog.snapshot]);
  const totals = indicativeTotals(lines, prices);
  const money = (n: number) => format.number(n, "egp");

  const unconfirmed = mine.some((i) => i.status !== "done");

  // Keep the builder on the device: every change, and the saved state while saves wait in the queue.
  useEffect(() => {
    if (!restored || leaving.current) return;
    if (!dirty && !unconfirmed) return;
    saveLocalDraft(userId, {
      slot,
      orderId: seed.orderId,
      serverVersion,
      customerId,
      visitId: seed.visitId,
      notes,
      lines,
      dirty,
      updatedAt: new Date().toISOString(),
    });
  }, [restored, userId, slot, seed.orderId, seed.visitId, serverVersion, customerId, notes, lines, dirty, unconfirmed]);

  const visibleCustomers = useMemo(() => {
    const f = customerFilter.trim().toLowerCase();
    const list = f
      ? customers.filter((c) => c.display_name.toLowerCase().includes(f) || (c.customer_no ?? "").toLowerCase().includes(f))
      : customers;
    // Keep the selected customer selectable while filtering.
    const selected = customers.find((c) => c.id === customerId);
    return selected && !list.includes(selected) ? [selected, ...list] : list;
  }, [customers, customerFilter, customerId]);

  const quantitiesValid = lines.every((l) => Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= MAX_QUANTITY);
  const canSave = canSaveDraft(customerId, lines) && !pending;

  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setDirty(true);
    setError(null);
  };
  const changeLines = edit<(prev: BuilderLine[]) => BuilderLine[]>((fn) => setLines(fn));
  const changeCustomer = edit(setCustomerId);
  const changeNotes = edit(setNotes);

  const setQuantity = (variantId: string, raw: string) => {
    const n = raw === "" ? 0 : Math.trunc(Number(raw));
    changeLines((prev) => prev.map((l) => (l.variant_id === variantId ? { ...l, quantity: Number.isFinite(n) ? n : 0 } : l)));
  };

  function startOver() {
    removeLocalDraft(userId, slot);
    setSeed(serverSeed);
    setCustomerId(serverSeed.customerId);
    setLines(serverSeed.lines);
    setNotes(serverSeed.notes);
    setDirty(false);
    setNotice("none");
    setError(null);
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setError(null);
    setPending(true);
    // A new draft's id is generated on the device at the first save and kept with the lines,
    // so every retry or replay of that save is the same draft (never a second order).
    const orderId = seed.orderId ?? crypto.randomUUID();
    if (seed.orderId === null) setSeed((s) => ({ ...s, orderId }));
    const queueItems = engine ? await engine.list().catch(() => items ?? []) : [];
    const payload = buildDraftPayload({
      orderId,
      customerId,
      lines,
      notes,
      visitId: seed.visitId,
      baseVersion: nextBaseVersion(draftItems(queueItems, orderId), serverVersion),
    });
    const customer = customers.find((c) => c.id === customerId);
    const isOnline = typeof navigator === "undefined" || navigator.onLine !== false;
    const outcome = await submitOrderDraft(payload, {
      online: isOnline,
      queue: engine,
      send: saveDraftOnDevice,
      summary: [customer?.display_name, t("summary", { count: lines.length })].filter(Boolean).join(" · "),
    });
    setPending(false);
    if (outcome.kind === "sent") {
      leaving.current = true;
      removeLocalDraft(userId, slot);
      router.push(`/orders/${orderId}?saved=1`);
      return;
    }
    if (outcome.kind === "queued") {
      setDirty(false);
      setNotice("none");
      // Queued while the device reports a connection (lost answer, or behind an earlier save): try now.
      if (engine && isOnline) void engine.sync().catch(() => undefined);
      return;
    }
    setError({ code: outcome.conflict ? "CONFLICT" : outcome.code, requestId: outcome.requestId });
  }

  const snapshotTime = catalog.snapshot ? format.dateTime(new Date(catalog.snapshot.at), CAIRO_DATE_TIME) : null;

  return (
    <form onSubmit={onSave} className="space-y-6 pb-28 sm:pb-0" noValidate>
      {!online ? (
        <Alert tone="info" role="status">
          {tOffline("offlineBanner")}
        </Alert>
      ) : null}

      {notice === "restored" ? (
        <Alert tone="info" role="status" className="flex flex-wrap items-center gap-2">
          <span className="flex-1">{tOffline("restored")}</span>
          {slot === NEW_SLOT ? (
            <Button type="button" variant="outline" onClick={startOver}>
              {tOffline("startOver")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {notice === "replaced" ? <Alert tone="info">{tOffline("replaced")}</Alert> : null}

      <DraftQueueNotice state={queueState} syncing={mine.some((i) => i.status === "syncing")} orderId={seed.orderId} dirty={dirty} />

      <Card className="space-y-3">
        <CardTitle>{t("customerTitle")}</CardTitle>
        {customers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noCustomers")}</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor={ids.filter}>{t("customerFilter")}</Label>
              <Input
                id={ids.filter}
                type="search"
                value={customerFilter}
                onChange={(e) => setCustomerFilter(e.target.value)}
                placeholder={t("customerFilterPlaceholder")}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={ids.customer}>{t("customer")}</Label>
              <Select id={ids.customer} value={customerId} onChange={(e) => changeCustomer(e.target.value)} required className="w-full">
                <option value="" disabled>
                  {t("selectCustomer")}
                </option>
                {visibleCustomers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.customer_no ? `${c.display_name} (${c.customer_no})` : c.display_name}
                  </option>
                ))}
              </Select>
            </div>
          </>
        )}
      </Card>

      <ProductSearch
        locale={locale}
        searchId={ids.search}
        resultsId={ids.results}
        full={lines.length >= MAX_LINES}
        online={online}
        snapshot={catalog.snapshot}
        snapshotTime={snapshotTime}
        prices={prices}
        onAdd={(v) => changeLines((prev) => addLine(prev, { variant_id: v.variant_id, quantity: 1, sku: v.sku, name: v.variant_name }))}
      />

      <Card className="space-y-3">
        <CardTitle>{t("linesTitle", { count: lines.length })}</CardTitle>
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noLines")}</p>
        ) : (
          <ul className="divide-y">
            {lines.map((line) => {
              const qtyId = `qty-${line.variant_id}`;
              const invalid = !(Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= MAX_QUANTITY);
              const price = prices.get(line.variant_id);
              return (
                <li key={line.variant_id} className="flex flex-wrap items-end gap-3 py-3">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-medium break-words">{line.name}</p>
                    <p dir="ltr" className="text-xs text-muted-foreground text-start">
                      {line.sku}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {price === undefined
                        ? tOffline("noPrice")
                        : tOffline("linePrice", { price: money(price), total: money(Math.round(price * Math.max(line.quantity, 0) * 100) / 100) })}
                    </p>
                  </div>
                  <div className="w-28 space-y-1">
                    <Label htmlFor={qtyId}>{t("quantity")}</Label>
                    <Input
                      id={qtyId}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_QUANTITY}
                      step={1}
                      value={line.quantity === 0 ? "" : line.quantity}
                      onChange={(e) => setQuantity(line.variant_id, e.target.value)}
                      aria-invalid={invalid || undefined}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => changeLines((prev) => prev.filter((l) => l.variant_id !== line.variant_id))}
                    aria-label={t("removeLine", { name: line.name })}
                  >
                    {t("remove")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {!quantitiesValid ? <p className="text-sm text-destructive">{t("quantityInvalid", { max: MAX_QUANTITY })}</p> : null}
        {lines.length > 0 ? (
          <div className="space-y-1 rounded-md bg-muted/50 p-3 text-sm">
            <p className="font-medium">
              {tOffline("indicativeTotal", { total: money(totals.total) })}
              {totals.missing > 0 ? <span className="ms-1 font-normal text-muted-foreground">{tOffline("missingPrices", { count: totals.missing })}</span> : null}
            </p>
            <p className="text-xs text-muted-foreground">{tOffline("indicativeLabel")}</p>
            {snapshotTime ? <p className="text-xs text-muted-foreground">{tOffline("pricesFrom", { time: snapshotTime })}</p> : null}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">{t("pricesHint")}</p>
      </Card>

      <Card className="space-y-2">
        <Label htmlFor={ids.notes}>{t("notes")}</Label>
        <Input id={ids.notes} name="notes" value={notes} onChange={(e) => changeNotes(e.target.value)} maxLength={1000} autoComplete="off" />
      </Card>

      {error ? <OrderError code={error.code} requestId={error.requestId} /> : null}

      {/* Primary action stays reachable at the bottom on phones. */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-card/95 p-3 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1">
          <div className="min-w-0 flex-1 text-sm text-muted-foreground">
            <p>{t("summary", { count: lines.length })}</p>
            {!online ? (
              <p id={ids.offline} className="text-xs">
                {tOffline("submitNeedsConnection")}
              </p>
            ) : null}
          </div>
          <Button type="submit" size="lg" disabled={!canSave} aria-describedby={!online ? ids.offline : undefined}>
            {pending ? t("saving") : online ? t("save") : tOffline("saveOnDevice")}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Where this draft's saves stand in the device queue. */
function DraftQueueNotice({
  state,
  syncing,
  orderId,
  dirty,
}: {
  state: ReturnType<typeof draftQueueState>;
  syncing: boolean;
  orderId: string | null;
  dirty: boolean;
}) {
  const t = useTranslations("orders.offline");
  const link = "inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline";
  if (state === "none") return null;
  if (state === "attention") {
    return (
      <Alert>
        <p>{t("attention")}</p>
        <Link href="/sync" className={link}>
          {t("openSync")}
        </Link>
      </Alert>
    );
  }
  if (state === "waiting") {
    return (
      <Alert tone="info" role="status" aria-live="polite">
        <p>
          <span className="font-medium">{t("savedTitle")}</span> {syncing ? t("sending") : t("willSync")}
        </p>
        <Link href="/sync" className={link}>
          {t("openSync")}
        </Link>
      </Alert>
    );
  }
  return (
    <Alert tone="success" role="status" aria-live="polite">
      <p>{dirty ? t("syncedThenChanged") : t("synced")}</p>
      {orderId ? (
        <Link href={`/orders/${orderId}`} className={link}>
          {t("openOrder")}
        </Link>
      ) : null}
    </Alert>
  );
}

function ProductSearch({
  locale,
  searchId,
  resultsId,
  full,
  online,
  snapshot,
  snapshotTime,
  prices,
  onAdd,
}: {
  locale: string;
  searchId: string;
  resultsId: string;
  full: boolean;
  online: boolean;
  snapshot: CatalogSnapshot | null;
  snapshotTime: string | null;
  prices: ReadonlyMap<string, number>;
  onAdd: (v: SellableVariant) => void;
}) {
  const t = useTranslations("orders.builder");
  const tOffline = useTranslations("orders.offline");
  const format = useFormatter();
  const [query, setQuery] = useState("");
  // The server's answer for one (sanitised) query; anything else on screen is derived from it.
  const [answer, setAnswer] = useState<{
    q: string;
    items: SellableVariant[] | null;
    error: { code: OrderErrorCode; requestId?: string } | null;
  } | null>(null);

  const q = sanitizeSearch(query);
  const active = q.length >= 2;
  const current = active && answer?.q === q ? answer : null;
  // Offline, or the server can't be reached: search the list saved on this device.
  const useLocal = active && (!online || current?.error?.code === "UNAVAILABLE");
  const localResults = useMemo(() => (useLocal ? searchCatalog(snapshot, q) : null), [useLocal, snapshot, q]);
  const loading = active && online && current === null;
  const results = useLocal ? localResults : (current?.items ?? null);
  const error = useLocal ? null : (current?.error ?? null);

  useEffect(() => {
    if (!active || !online) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const res = await searchVariants(q).catch(() => ({ ok: false as const, errorCode: "UNAVAILABLE" as const, requestId: undefined }));
      if (cancelled) return;
      setAnswer(res.ok ? { q, items: res.items, error: null } : { q, items: null, error: { code: res.errorCode, requestId: res.requestId } });
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, online, q]);

  return (
    <Card className="space-y-3">
      <CardTitle>{t("productsTitle")}</CardTitle>
      <div className="space-y-2">
        <Label htmlFor={searchId}>{t("search")}</Label>
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          autoComplete="off"
          aria-controls={resultsId}
        />
        {!online ? (
          <p className="text-xs text-muted-foreground">
            {snapshotTime ? tOffline("localSearch", { time: snapshotTime }) : tOffline("noSnapshot")}
            {snapshot?.truncated ? <> {tOffline("truncated")}</> : null}
          </p>
        ) : null}
      </div>
      <div id={resultsId} aria-live="polite" aria-busy={loading}>
        {useLocal && online ? <p className="text-xs text-muted-foreground">{tOffline("localFallback")}</p> : null}
        {error ? <OrderError code={error.code} requestId={error.requestId} /> : null}
        {loading ? <p className="text-sm text-muted-foreground">{t("searching")}</p> : null}
        {!loading && results !== null && results.length === 0 ? (
          <p className="text-sm text-muted-foreground">{useLocal && !snapshot ? tOffline("noSnapshot") : t("noResults")}</p>
        ) : null}
        {results !== null && results.length > 0 ? (
          <ul className="divide-y">
            {results.map((v) => {
              const price = prices.get(v.variant_id);
              return (
                <li key={v.variant_id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">{v.variant_name}</p>
                    <p className="text-xs text-muted-foreground break-words">
                      {[localizedName(locale, v.product_name_en, v.product_name_ar), v.brand_name].filter(Boolean).join(" · ")}
                      {" · "}
                      <span dir="ltr">{v.sku}</span>
                      {price !== undefined ? <> · {tOffline("unitPrice", { price: format.number(price, "egp") })}</> : null}
                    </p>
                  </div>
                  <Button type="button" variant="outline" disabled={full} onClick={() => onAdd(v)} aria-label={t("addLine", { name: v.variant_name })}>
                    {t("add")}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {full ? <p className="text-sm text-muted-foreground">{t("maxLines", { max: MAX_LINES })}</p> : null}
      </div>
    </Card>
  );
}
