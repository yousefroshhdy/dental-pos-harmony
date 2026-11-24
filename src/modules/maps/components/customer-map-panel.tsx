import { getFormatter, getTranslations } from "next-intl/server";
import { Card, CardTitle } from "@/components/ui/primitives";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { toLatLng } from "@/lib/maps/geo";
import { localizedName, MAX_LOCATION_ACCURACY_M } from "@/modules/crm/logic";
import { listCustomerProposals, mapsBrowserKey } from "../queries";
import { CustomerMapClient, type PanelProposal } from "./customer-map-client";
import { DecideProposalForm } from "./decide-proposal-form";

const CAIRO_DATE_TIME = { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo", numberingSystem: "latn" } as const;

/**
 * The map card on the customer detail page (one insertion line there). Shows the clinic pin,
 * distance and directions; verifiers can set or move the pin and decide pending proposals
 * from reps' first check-ins. Data: the customer row the page already read, plus the
 * proposals RLS lets the user see.
 */
export async function CustomerMapPanel({
  customer,
  locale,
}: {
  customer: { id: string; display_name: string; latitude: number | string | null; longitude: number | string | null; archived_at: string | null };
  locale: string;
}) {
  const lang = locale === "en" ? "en" : "ar";
  const t = await getTranslations("maps.customer");
  const format = await getFormatter();
  const ctx = await getUserContext();
  const canLocate = customer.archived_at === null && can(ctx, "crm.customer_location.verify");
  const proposals = await listCustomerProposals(customer.id);
  const pending = proposals.ok ? proposals.data : [];
  const pins: PanelProposal[] = [];
  for (const p of pending) {
    const at = toLatLng(p.latitude, p.longitude);
    if (at) pins.push({ id: p.id, ...at, repName: localizedName(locale, p.proposed_by_name_en, p.proposed_by_name_ar) });
  }

  return (
    <Card className="space-y-3">
      <CardTitle>{t("title")}</CardTitle>
      <CustomerMapClient
        apiKey={mapsBrowserKey()}
        locale={lang}
        customerId={customer.id}
        name={customer.display_name}
        clinic={toLatLng(customer.latitude, customer.longitude)}
        canLocate={canLocate}
        proposals={pins}
      />
      {pending.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("pendingTitle", { count: String(pending.length) })}</h3>
          <ul className="space-y-3">
            {pending.map((p) => {
              const accuracy = p.accuracy_m === null ? null : Math.round(Number(p.accuracy_m));
              return (
                <li key={p.id} className="space-y-2 rounded-lg border p-3 text-sm">
                  <p>
                    {t("proposalLine", {
                      name: localizedName(locale, p.proposed_by_name_en, p.proposed_by_name_ar) || "—",
                      time: format.dateTime(new Date(p.captured_at), CAIRO_DATE_TIME),
                      metres: accuracy === null ? "?" : String(accuracy),
                    })}
                  </p>
                  {canLocate ? <DecideProposalForm proposalId={p.id} inaccurate={accuracy === null || accuracy > MAX_LOCATION_ACCURACY_M} /> : <p className="text-muted-foreground">{t("awaiting")}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </Card>
  );
}
