"use client";

import { CrmRouteError } from "@/modules/crm/components/route-states";

export default function OpportunitiesError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <CrmRouteError reset={reset} />;
}
