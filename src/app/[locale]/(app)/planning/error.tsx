"use client"; // Error boundaries must be Client Components

import { PlanningRouteError } from "@/modules/planning/components/route-error";

export default function Error({ retry }: { error: unknown; retry: () => void }) {
  return <PlanningRouteError retry={retry} />;
}
