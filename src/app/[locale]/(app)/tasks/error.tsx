"use client"; // Error boundaries must be Client Components

import { RouteError } from "@/modules/field/components/route-error";

export default function Error({ retry }: { error: unknown; retry: () => void }) {
  return <RouteError retry={retry} />;
}
