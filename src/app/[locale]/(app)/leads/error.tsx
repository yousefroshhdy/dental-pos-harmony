"use client"; // Error boundaries must be Client Components

import { LeadsRouteError } from "@/modules/leads/components/route-error";

export default function Error({ retry }: { error: unknown; retry: () => void }) {
  return <LeadsRouteError retry={retry} />;
}
