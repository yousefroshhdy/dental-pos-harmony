"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { MapsActionState } from "../types";

/** The failure of a maps action, translated (own codes first, then the shared errors.*). */
export function MapsActionMessage({ state }: { state: MapsActionState }) {
  const t = useTranslations("maps.errors");
  const tErrors = useTranslations("errors");
  if (!state || state.ok) return null;
  return (
    <Alert role="alert">
      {state.mapsCode ? t(state.mapsCode) : tErrors(state.messageKey, { requestId: state.requestId ?? "—" })}
    </Alert>
  );
}
