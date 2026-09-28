Copies of expo-router 57.0.21's own image assets (assets/*.png and
assets/react-navigation/elements/*.png, from React Navigation), MIT licensed
(Copyright (c) 650 Industries, Inc. and the React Navigation contributors).

Only the web build uses these: metro.config.js redirects any image that
resolves inside node_modules to the file of the same name here, because the
web export otherwise writes it to assets/__node_modules/.pnpm/<package>@<version>_<hash>/...
— paths past Windows' MAX_PATH once installed. Native builds keep the
package's own files. After an expo-router upgrade, re-copy them; the export
fails and names any file missing here.
