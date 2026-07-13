import { en, type TranslationKey } from "../locales/en";

const catalogs = { en } as const;
export type Locale = keyof typeof catalogs;

export function translate(
  key: TranslationKey,
  variables: Record<string, string | number> = {},
  locale: Locale = "en",
): string {
  return Object.entries(variables).reduce(
    (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
    catalogs[locale][key] as string,
  );
}
