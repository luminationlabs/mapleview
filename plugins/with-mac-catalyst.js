const {
  withXcodeProject,
  withPodfile,
  withEntitlementsPlist,
} = require('@expo/config-plugins');

const withMacCatalystXcode = (config, developmentTeam) => {
  return withXcodeProject(config, (config) => {
    const xcodeProject = config.modResults;
    const configurations = xcodeProject.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const entry = configurations[key];
      if (!entry || typeof entry !== 'object') continue;
      const buildSettings = entry.buildSettings;
      if (!buildSettings) continue;
      // The `xcode` library may return PRODUCT_NAME wrapped in literal
      // quotes (e.g. '"MapleView"'), so normalize before comparing.
      const productName =
        typeof buildSettings.PRODUCT_NAME === 'string'
          ? buildSettings.PRODUCT_NAME.replace(/^"(.*)"$/, '$1')
          : buildSettings.PRODUCT_NAME;
      if (productName === 'MapleView') {
        buildSettings.SUPPORTS_MACCATALYST = 'YES';
        // App Sandbox requires real code signing; "Sign to Run Locally" is
        // rejected. Pin the team so xcodebuild can auto-provision.
        buildSettings.DEVELOPMENT_TEAM = developmentTeam;
        buildSettings.CODE_SIGN_STYLE = 'Automatic';
      }
    }
    return config;
  });
};

const FIX_SCRIPT_MARKER = '# with-mac-catalyst: fix prebuilt framework layouts';
const FIX_SCRIPT_BLOCK = `
    ${FIX_SCRIPT_MARKER}
    system("#{File.dirname(__FILE__)}/../scripts/fix-maccatalyst-frameworks.sh") || raise("fix-maccatalyst-frameworks.sh failed")
`;

const withMacCatalystPodfile = (config) => {
  return withPodfile(config, (config) => {
    let contents = config.modResults.contents.replace(
      /:mac_catalyst_enabled\s*=>\s*false/,
      ':mac_catalyst_enabled => true'
    );
    if (!contents.includes(FIX_SCRIPT_MARKER)) {
      // Match through the closing ')' on its own line so we don't stop
      // inside a nested call like ccache_enabled?(podfile_properties).
      contents = contents.replace(
        /(react_native_post_install\([\s\S]*?\n\s+\))/,
        `$1\n${FIX_SCRIPT_BLOCK}`
      );
    }
    config.modResults.contents = contents;
    return config;
  });
};

const withMacCatalystEntitlements = (config, keychainAccessGroup) => {
  return withEntitlementsPlist(config, (config) => {
    const plist = config.modResults;
    const groups = Array.isArray(plist['keychain-access-groups'])
      ? plist['keychain-access-groups']
      : [];
    if (!groups.includes(keychainAccessGroup)) {
      plist['keychain-access-groups'] = [...groups, keychainAccessGroup];
    }
    // Mac Catalyst-only keys; iOS ignores them. Sandboxing keeps the app's
    // Documents directory inside ~/Library/Containers/<bundle>/ instead of
    // the user's ~/Documents.
    plist['com.apple.security.app-sandbox'] = true;
    plist['com.apple.security.network.client'] = true;
    return config;
  });
};

const withMacCatalyst = (config) => {
  const developmentTeam = process.env.APPLE_TEAM_ID;
  if (!developmentTeam) {
    throw new Error(
      'with-mac-catalyst: APPLE_TEAM_ID env var is required ' +
      '(your Apple Developer Team ID, e.g. ABCDE12345). Set it in ' +
      '.env.local for `expo run:ios` / `npx expo prebuild`, and in ' +
      "eas.json under each build profile's `env` block for `eas build`."
    );
  }
  const bundleId = config.ios && config.ios.bundleIdentifier;
  if (!bundleId) {
    throw new Error(
      'with-mac-catalyst: ios.bundleIdentifier is required in app.config.ts.'
    );
  }
  const keychainAccessGroup = `${developmentTeam}.${bundleId}`;
  return withMacCatalystPodfile(
    withMacCatalystEntitlements(
      withMacCatalystXcode(config, developmentTeam),
      keychainAccessGroup,
    ),
  );
};

module.exports = withMacCatalyst;
