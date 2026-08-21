import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.mushfiq.booksync",
  appName: "BookSync Reader",
  webDir: "mobile-dist",
  bundledWebRuntime: false,
  android: {
    allowMixedContent: false,
    backgroundColor: "#10110f",
  },
};

export default config;
