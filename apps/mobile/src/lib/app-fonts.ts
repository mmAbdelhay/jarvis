// The app's font faces, as vendored files under assets/fonts (OFL-1.1; the
// licence texts sit beside them).
//
// Not imported from @expo-google-fonts: each package's index requires every
// weight it has (28 JetBrains Mono and Manrope files), and Metro bundles all
// of them. On the web export each one also became a file at
// assets/__node_modules/.pnpm/<package>@<version>/…, over 200 characters —
// past Windows' MAX_PATH once installed under resources/web. Vendored, only
// the weights the app uses ship, at short paths, on every platform alike.
export const APP_FONTS = {
  Manrope_400Regular: require("../../assets/fonts/Manrope_400Regular.ttf"),
  Manrope_500Medium: require("../../assets/fonts/Manrope_500Medium.ttf"),
  Manrope_600SemiBold: require("../../assets/fonts/Manrope_600SemiBold.ttf"),
  Manrope_700Bold: require("../../assets/fonts/Manrope_700Bold.ttf"),
  Manrope_800ExtraBold: require("../../assets/fonts/Manrope_800ExtraBold.ttf"),
  JetBrainsMono_400Regular: require("../../assets/fonts/JetBrainsMono_400Regular.ttf"),
  JetBrainsMono_500Medium: require("../../assets/fonts/JetBrainsMono_500Medium.ttf"),
  JetBrainsMono_600SemiBold: require("../../assets/fonts/JetBrainsMono_600SemiBold.ttf"),
} as const;
