import { xProvider } from "./x-provider.js";
import { tiktokProvider } from "./tiktok-provider.js";
import { youtubeProvider } from "./youtube-provider.js";

export function createPlatformRegistry() {
  const providers = new Map([
    [tiktokProvider.platform, tiktokProvider],
    [youtubeProvider.platform, youtubeProvider],
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
