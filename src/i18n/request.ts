import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { MESSAGE_MODULES } from "./modules";
import { routing } from "./routing";

async function loadMessages(locale: string) {
  const core = (await import(`../../messages/${locale}.json`)).default;
  const modules = await Promise.all(
    MESSAGE_MODULES.map(async (m) => [m, (await import(`../../messages/${locale}/${m}.json`)).default] as const),
  );
  return { ...core, ...Object.fromEntries(modules) };
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return {
    locale,
    timeZone: "Africa/Cairo",
    messages: await loadMessages(locale),
    formats: {
      number: { egp: { style: "currency", currency: "EGP", numberingSystem: "latn" } },
      dateTime: { short: { day: "2-digit", month: "short", year: "numeric" } },
    },
  };
});
