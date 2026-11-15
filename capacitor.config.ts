import type { CapacitorConfig } from '@capacitor/cli';
import { resolveDemoTestRecipient, validateDemoApiOrigin } from './src/lib/demo-policy';

const demoRecipient = resolveDemoTestRecipient('staging', process.env.VITE_DEMO_TEST_RECIPIENT);
if (demoRecipient) validateDemoApiOrigin(process.env.ANDROID_API_ORIGIN);

const config: CapacitorConfig = {
  appId: demoRecipient ? 'pl.borczuwa.app.demo' : 'pl.borczuwa.app',
  appName: demoRecipient ? 'Bór czuwa · TEST' : 'Bór czuwa',
  webDir: 'build',
  android: {
    minWebViewVersion: 107,
    // Huawei uses a separate version scheme; no Chromium-compatible release is verified.
    minHuaweiWebViewVersion: 2147483647
  },
  server: { errorPath: 'webview-update.html' }
};

export default config;
