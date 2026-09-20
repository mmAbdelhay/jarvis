// Thin: the provider value is set once in app/_layout.tsx after prefs load
// and I18nManager is applied. No logic lives here.
import { createContext, useContext } from "react";
import type { Language } from "./i18n";

export const LanguageContext = createContext<Language>("en");

export function useLanguage(): Language {
  return useContext(LanguageContext);
}
