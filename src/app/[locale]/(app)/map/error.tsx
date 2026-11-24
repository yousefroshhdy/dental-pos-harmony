"use client"; // Error boundaries must be Client Components

import { MapsRouteError } from "@/modules/maps/components/route-error";

export default function Error({ retry }: { error: unknown; retry: () => void }) {
  return <MapsRouteError retry={retry} />;
}
