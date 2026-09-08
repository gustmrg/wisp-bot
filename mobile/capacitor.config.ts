import type { CapacitorConfig } from "@capacitor/cli";
const config: CapacitorConfig = {
  appId: "com.gustavomiranda.wispbot",
  appName: "Wisp Bot",
  webDir: "../dist-mobile",
  loggingBehavior: "none",
  server: { hostname: "localhost", iosScheme: "capacitor", androidScheme: "https", cleartext: false },
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
  ios: { contentInset: "never", webContentsDebuggingEnabled: false },
  plugins: { CapacitorHttp: { enabled: false }, CapacitorCookies: { enabled: false } },
};
export default config;
