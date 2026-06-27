import { xProvider } from "./x-provider.js";
import { tiktokProvider } from "./tiktok-provider.js";

export function createPlatformRegistry() {
  const providers = new Map([
    [xProvider.platform, xProvider],
    [tiktokProvider.platform, tiktokProvider]
  ]);

  return {
    get(platform) {
      return providers.get(platform);
    },
    list() {
      return [...providers.keys()];
    }
  };
}
