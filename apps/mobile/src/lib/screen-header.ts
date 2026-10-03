// What a ScreenHeader draws, decided without any React: whether the back
// chevron shows, whether it mirrors, and whether the subtitle line exists.
import { isRtl, type Language } from "./i18n";

export type ScreenHeaderInput = {
  language: Language;
  subtitle?: string | undefined;
  hasBack: boolean;
};

export type ScreenHeaderModel = {
  showBack: boolean;
  /** The back chevron points the other way in a right-to-left layout. */
  backMirrored: boolean;
  /** Undefined when there is nothing to say, so no empty line is drawn. */
  subtitle: string | undefined;
};

export function screenHeaderModel(input: ScreenHeaderInput): ScreenHeaderModel {
  const subtitle = input.subtitle?.trim();
  return {
    showBack: input.hasBack,
    backMirrored: isRtl(input.language),
    subtitle: subtitle === undefined || subtitle === "" ? undefined : subtitle,
  };
}
