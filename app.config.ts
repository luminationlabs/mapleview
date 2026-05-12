import * as fs from "fs";
import * as path from "path";
import type { ConfigContext } from "expo/config";

// EAS CLI's fallback config evaluator runs plugins before loading .env*
// files, so anything reading process.env (e.g. with-mac-catalyst) fails
// unless we hydrate first. Plain fs sidesteps @expo/env's LOADED-flag
// short-circuit, which EAS sometimes sets pre-load against the wrong cwd.
function hydrateEnvLocal(): void {
  for (const dir of [__dirname, process.cwd()]) {
    const envPath = path.join(dir, ".env.local");
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2];
      }
    }
    return;
  }
}
hydrateEnvLocal();

// Static app.json (gitignored) supplies extra.eas.projectId; see README.
export default ({ config }: ConfigContext) => ({
  ...config,
  name: "Maple View",
  slug: "cameraview",
  version: "1.1.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "cameraview",
  userInterfaceStyle: "dark",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.luminationlabs.cameraview",
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: "com.luminationlabs.cameraview",
    adaptiveIcon: {
      backgroundColor: "#000000",
      foregroundImage: "./assets/images/icon.png",
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        backgroundColor: "#000000",
        dark: {
          backgroundColor: "#000000",
        },
      },
    ],
    "expo-font",
    "expo-image",
    "expo-iap",
    "./plugins/with-mac-catalyst",
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    ...config.extra,
    router: {},
  },
});
