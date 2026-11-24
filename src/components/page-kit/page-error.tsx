import type { ReactNode } from "react";
import type { TranslatedCode } from "@/lib/errors";
import { ListError } from "./list-error";

/** A whole page whose main read failed: the way back, then the error (with step-up when MFA is needed). */
export function PageError({ back, error, title }: { back?: ReactNode; error: { messageKey: TranslatedCode; requestId?: string }; title?: string }) {
  return (
    <div className="space-y-6">
      {back}
      <ListError error={error} title={title} />
    </div>
  );
}
