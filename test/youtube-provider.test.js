import test from "node:test";
import assert from "node:assert/strict";
import { createPlatformRegistry } from "../backend/platforms/registry.js";
import { youtubeProvider, __testing } from "../backend/platforms/youtube-provider.js";

test("YouTube provider normalizes supported profile URL shapes", () => {
  assert.equal(youtubeProvider.buildProfileUrl("@BeautyCreator"), "https://www.youtube.com/@BeautyCreator");
  assert.equal(youtubeProvider.buildProfileUrl("channel/UCabc123_xyz"), "https://www.youtube.com/channel/UCabc123_xyz");
  assert.equal(youtubeProvider.buildProfileUrl("c/BeautyStudio"), "https://www.youtube.com/c/BeautyStudio");
  assert.equal(youtubeProvider.buildProfileUrl("user/OldCreator"), "https://www.youtube.com/user/OldCreator");
  assert.equal(youtubeProvider.buildProfileUrl("watch?v=abc"), "");
});

test("YouTube provider is registered", () => {
  const registry = createPlatformRegistry();

  assert.equal(registry.get("youtube"), youtubeProvider);
  assert.ok(registry.list().includes("youtube"));
});

test("YouTube search queries include channel profile site operators", () => {
  const queries = __testing.buildSearchQueries({
    query: "beauty review creator",
    positiveTerms: ["beauty", "review"],
    negativeTerms: ["shop"],
    aiSearch: {
      queries: ["site:x.com skincare creator"]
    }
  }, { country: "JP" });

  assert.ok(queries.some((query) => query.includes("site:youtube.com/@")));
  assert.ok(queries.some((query) => query.includes("site:youtube.com/channel")));
  assert.ok(queries.some((query) => query.includes("Japan Japanese")));
  assert.ok(queries.every((query) => !query.includes("site:x.com")));
});

test("YouTube parser extracts channel candidates and subscriber evidence", () => {
  const creators = __testing.parseYoutubeCreators(`
    1. [Beauty Lab - YouTube](https://www.youtube.com/@BeautyLab) - skincare review creator with 1.2M subscribers
    2. [Brand Official Store](https://www.youtube.com/@brandstore) - official store channel
    3. https://www.youtube.com/channel/UCabc123_xyz makeup tutorials with 25K subscribers
  `, "site:youtube.com/@ beauty review", {
    query: "beauty review",
    positiveTerms: ["beauty", "review"],
    negativeTerms: ["store"]
  });

  assert.equal(creators.length, 2);
  assert.equal(creators[0].handle, "@BeautyLab");
  assert.equal(creators[0].metrics.followers, 1_200_000);
  assert.equal(creators[1].handle, "channel/UCabc123_xyz");
  assert.equal(creators[1].profileUrl, "https://www.youtube.com/channel/UCabc123_xyz");
});

test("YouTube fallback search uses Jina search and never Yahoo", async () => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.KOL_DATA_API_URL;
  const previousJinaKey = process.env.JINA_API_KEY;
  const calls = [];
  try {
    delete process.env.KOL_DATA_API_URL;
    process.env.JINA_API_KEY = "jina_test";
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), headers: options.headers || {} });
      if (String(url).startsWith("https://s.jina.ai/")) {
        return new Response(`
          [Beauty Lab - YouTube](https://www.youtube.com/@BeautyLab) - skincare review creator with 42K subscribers
        `, { status: 200 });
      }

      return new Response(`
        <html>
          <head>
            <meta property="og:title" content="Beauty Lab">
            <meta property="og:description" content="Skincare reviews and makeup tutorials. 42K subscribers">
          </head>
          <body>42K subscribers</body>
        </html>
      `, { status: 200 });
    };

    const creators = await youtubeProvider.discoverCreators({
      query: "beauty review",
      positiveTerms: ["beauty", "review"],
      negativeTerms: []
    }, { limit: 5 });

    assert.equal(creators[0].platform, "youtube");
    assert.equal(creators[0].profileUrl, "https://www.youtube.com/@BeautyLab");
    assert.equal(creators.discoveryMeta.searchProvider, "jina-search");
    assert.ok(calls.some((call) => call.url.startsWith("https://s.jina.ai/")));
    assert.ok(calls.every((call) => !call.url.includes("search.yahoo.com")));
    assert.equal(calls.find((call) => call.url.startsWith("https://s.jina.ai/")).headers.Authorization, "Bearer jina_test");
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) {
      delete process.env.KOL_DATA_API_URL;
    } else {
      process.env.KOL_DATA_API_URL = previousUrl;
    }
    if (previousJinaKey === undefined) {
      delete process.env.JINA_API_KEY;
    } else {
      process.env.JINA_API_KEY = previousJinaKey;
    }
  }
});

test("YouTube fallback skips public search when Jina is not configured", async () => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.KOL_DATA_API_URL;
  const previousJinaKey = process.env.JINA_API_KEY;
  let fetchCalls = 0;
  try {
    delete process.env.KOL_DATA_API_URL;
    delete process.env.JINA_API_KEY;
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error("unexpected network call");
    };

    const creators = await youtubeProvider.discoverCreators({
      query: "beauty review",
      positiveTerms: ["beauty", "review"],
      negativeTerms: []
    }, { limit: 5 });

    assert.equal(creators.length, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(creators.discoveryMeta.searchProvider, "none");
    assert.ok(creators.discoveryMeta.errors.includes("未配置 JINA_API_KEY，已跳过 YouTube 公开搜索"));
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) {
      delete process.env.KOL_DATA_API_URL;
    } else {
      process.env.KOL_DATA_API_URL = previousUrl;
    }
    if (previousJinaKey === undefined) {
      delete process.env.JINA_API_KEY;
    } else {
      process.env.JINA_API_KEY = previousJinaKey;
    }
  }
});

test("YouTube fallback search source failures return diagnostics instead of throwing", async () => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.KOL_DATA_API_URL;
  const previousJinaKey = process.env.JINA_API_KEY;
  const calls = [];
  try {
    delete process.env.KOL_DATA_API_URL;
    process.env.JINA_API_KEY = "jina_test";
    global.fetch = async (url) => {
      calls.push(String(url));
      return new Response("temporary search failure", { status: 500 });
    };

    const creators = await youtubeProvider.discoverCreators({
      query: "beauty review",
      positiveTerms: ["beauty", "review"],
      negativeTerms: []
    }, { limit: 5 });

    assert.equal(creators.length, 0);
    assert.equal(creators.discoveryMeta.rawFetched, 0);
    assert.equal(creators.discoveryMeta.searchProvider, "jina-search");
    assert.ok(creators.discoveryMeta.errors.some((error) => error.includes("Jina Search 请求失败：500")));
    assert.ok(calls.every((url) => !url.includes("search.yahoo.com")));
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) {
      delete process.env.KOL_DATA_API_URL;
    } else {
      process.env.KOL_DATA_API_URL = previousUrl;
    }
    if (previousJinaKey === undefined) {
      delete process.env.JINA_API_KEY;
    } else {
      process.env.JINA_API_KEY = previousJinaKey;
    }
  }
});

test("YouTube public profile enrichment maps subscribers to followers", async () => {
  const previousFetch = global.fetch;
  try {
    global.fetch = async () => new Response(`
      <html>
        <head>
          <title>Beauty Lab - YouTube</title>
          <meta property="og:title" content="Beauty Lab">
          <meta property="og:description" content="Skincare reviews and makeup tutorials. Contact hello@example.com. 42K subscribers">
          <meta property="og:image" content="https://yt.example/avatar.jpg">
        </head>
        <body>42K subscribers</body>
      </html>
    `, { status: 200 });

    const enriched = await __testing.enrichFromPublicProfile({
      platform: "youtube",
      handle: "@BeautyLab",
      profileUrl: "https://www.youtube.com/@BeautyLab",
      metrics: {},
      discovery: { evidenceText: "skincare review creator" },
      contact: {},
      tags: []
    });

    assert.equal(enriched.name, "Beauty Lab");
    assert.equal(enriched.metrics.followers, 42_000);
    assert.equal(enriched.contact.email, "hello@example.com");
    assert.equal(enriched.avatarUrl, "https://yt.example/avatar.jpg");
    assert.equal(enriched.enrichment.status, "enriched");
  } finally {
    global.fetch = previousFetch;
  }
});

test("YouTube third-party discovery sends platform youtube", async () => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.KOL_DATA_API_URL;
  const requests = [];
  try {
    process.env.KOL_DATA_API_URL = "https://data.example/search";
    global.fetch = async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        creators: [{
          name: "Tech Creator",
          handle: "@TechCreator",
          profileUrl: "https://www.youtube.com/@TechCreator",
          metrics: { subscribers: 100000 }
        }]
      }), { status: 200 });
    };

    const creators = await youtubeProvider.discoverCreators({
      query: "tech review",
      positiveTerms: ["tech"],
      negativeTerms: ["shop"]
    }, { limit: 5 });

    assert.equal(requests[0].body.platform, "youtube");
    assert.equal(requests[0].body.limit, 5);
    assert.equal(creators[0].platform, "youtube");
    assert.equal(creators[0].metrics.followers, 100000);
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) {
      delete process.env.KOL_DATA_API_URL;
    } else {
      process.env.KOL_DATA_API_URL = previousUrl;
    }
  }
});
