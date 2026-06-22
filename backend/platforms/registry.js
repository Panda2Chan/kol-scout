import { xProvider } from "./x-provider.js";

export function createPlatformRegistry() {
  const providers = new Map([[xProvider.platform, xProvider]]);

  return {
    get(platform) {
      return providers.get(platform);
    },
    list() {
      return [...providers.keys()];
    }
  };
}
