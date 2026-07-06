import { xProvider } from "./x-provider.js";
import { tiktokProvider } from "./tiktok-provider.js";

export function createPlatformRegistry() {
  const providers = new Map([
    [tiktokProvider.platform, tiktokProvider],
    [xProvider.platform, xProvider]
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
