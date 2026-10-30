"use client"; // Error boundaries must be Client Components

import { TrackingRouteError } from "@/modules/tracking/components/route-error";

export default function Error({ retry }: { error: unknown; retry: () => void }) {
  return <TrackingRouteError retry={retry} />;
}
