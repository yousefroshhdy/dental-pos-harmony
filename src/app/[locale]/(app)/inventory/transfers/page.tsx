import type { Metadata } from "next";
import { PlusIcon } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Link } from "@/i18n/navigation";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { InventoryError } from "@/modules/inventory/components/inventory-error";
import { TransfersTable, type TransferViewRow } from "@/modules/inventory/components/inventory-tables";
import { TRANSFER_LIST } from "@/modules/inventory/lists";
import { canReadTransfers, isTransferStatus, parseStockFilters, releaseBlocked, toQuery, transferActions, type SearchParams } from "@/modules/inventory/logic";
import { countInTransit, listTransferLines, listTransfersPage, listWarehouses } from "@/modules/inventory/queries";
import type { TransferLineRow } from "@/modules/inventory/types";
import { pageRequest } from "@/modules/orders/kit/paging";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "inventory.transfers" });
  return { title: t("title") };
}

export default async function TransfersPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!canReadTransfers(ctx)) return <Forbidden />;

  const sp = await searchParams;
  const rawStatus = typeof sp.status === "string" ? sp.status : "";
  const status = isTransferStatus(rawStatus) ? rawStatus : undefined;
  const { warehouse } = parseStockFilters(sp);
  const highlight = typeof sp.highlight === "string" ? sp.highlight : undefined;
  const t = await getTranslations("inventory.transfers");

  const [transfers, warehouses, inTransit] = await Promise.all([listTransfersPage({ status, warehouse }, pageRequest(sp, TRANSFER_LIST)), listWarehouses(), countInTransit(warehouse)]);
  const pageRows = transfers.ok ? transfers.data.rows : [];
  const lines = await listTransferLines(pageRows.map((x) => x.id));
  const linesByTransfer = new Map<string, TransferLineRow[]>();
  for (const l of lines.ok ? lines.data : []) linesByTransfer.set(l.transfer_id, [...(linesByTransfer.get(l.transfer_id) ?? []), l]);
  const whById = new Map((warehouses.ok ? warehouses.data : []).map((w) => [w.id, w]));

  const rows: TransferViewRow[] = pageRows.map((x) => {
    const from = whById.get(x.from_warehouse_id);
    const to = whById.get(x.to_warehouse_id);
    return {
      transfer: x,
      lines: linesByTransfer.get(x.id) ?? [],
      from: { kind: from?.kind ?? null, sellable: from?.is_sellable },
      to: { kind: to?.kind ?? null, sellable: to?.is_sellable },
      actions: transferActions(ctx, x, { from: from?.kind, to: to?.kind }),
      // D-13: receiving released quarantine stock needs inventory.quarantine.release.
      receiveNeedsRelease: x.status === "in_transit" && can(ctx, "inventory.transfer.receive") && releaseBlocked(ctx, from?.kind, to?.kind),
    };
  });
  const newTransfer = can(ctx, "inventory.transfer.create") ? (
    <Link href="/inventory/transfers/new" className={buttonVariants()}>
      <PlusIcon aria-hidden="true" />
      {t("new")}
    </Link>
  ) : null;

  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("intro")} actions={newTransfer} />

      {inTransit.ok && inTransit.data > 0 && status !== "in_transit" ? (
        <Link
          href={`/inventory/transfers${toQuery({ status: "in_transit", warehouse })}`}
          className="block min-h-11 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm hover:bg-primary/15"
        >
          {t("inTransitBanner", { n: inTransit.data })}
        </Link>
      ) : null}

      <TransfersTable
        rows={rows}
        total={transfers.ok ? transfers.data.total : 0}
        warehouses={[...whById.values()].map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))}
        values={{ status, warehouse }}
        highlight={highlight}
        linesUnavailable={!lines.ok}
        emptyAction={newTransfer}
        error={transfers.ok ? undefined : <InventoryError code={transfers.error.code} messageKey={transfers.error.messageKey} requestId={transfers.error.requestId} />}
      />
    </div>
  );
}
