import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return {
    locale,
    timeZone: "Africa/Cairo",
    messages: (await import(`../../messages/${locale}.json`)).default,
    formats: {
      number: { egp: { style: "currency", currency: "EGP", numberingSystem: "latn" } },
      dateTime: { short: { day: "2-digit", month: "short", year: "numeric" } },
    },
  };
});
