import { getTranslations } from "next-intl/server";

/** Google's Terms of Service and Privacy Policy, linked wherever Google Maps content is shown. */
export const GOOGLE_MAPS_TERMS_URL = "https://maps.google.com/help/terms_maps/";
export const GOOGLE_PRIVACY_URL = "https://policies.google.com/privacy";

/**
 * Attribution for Places content shown outside a Google map (Places API (New) policies): the
 * "Google Maps" source credit, the third-party providers Google returned for these places, and
 * links to Google's Terms and Privacy Policy. The text is left-to-right Latin as Google writes it.
 */
export async function GoogleAttribution({ providers = [] }: { providers?: { provider: string; providerUri: string | null }[] }) {
  const t = await getTranslations("leads.attribution");
  return (
    <footer className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
      <p>
        {t("source")}{" "}
        <span dir="ltr" lang="en" translate="no" className="font-medium text-foreground">
          Google Maps
        </span>
      </p>
      {providers.length > 0 ? (
        <p>
          {t("providers")}{" "}
          {providers.map((p, i) => (
            <span key={p.provider}>
              {i > 0 ? ", " : null}
              {p.providerUri ? (
                <a href={p.providerUri} target="_blank" rel="noopener noreferrer" className="tap-link underline underline-offset-4">
                  {p.provider}
                </a>
              ) : (
                p.provider
              )}
            </span>
          ))}
        </p>
      ) : null}
      <p className="flex flex-wrap gap-x-4">
        <a href={GOOGLE_MAPS_TERMS_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline underline-offset-4">
          {t("terms")}
        </a>
        <a href={GOOGLE_PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline underline-offset-4">
          {t("privacy")}
        </a>
      </p>
    </footer>
  );
}
