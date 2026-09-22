import { defineApp } from "convex/server";
import { v } from "convex/values";
import agentmail from "@agentmail/convex/convex.config";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// Our own http.ts routes live under /api so static hosting can own "/".
// Firecrawl is mounted without an httpPrefix on purpose: we only use scrape and
// search, which return inline in an action, so there is no crawl webhook to route.
// That sidesteps the undocumented precedence question between a component at "/"
// and a component at "/firecrawl/".
const app = defineApp({
  httpPrefix: "/api",
  env: {
    FIRECRAWL_API_KEY: v.string(),
    AGENTMAIL_API_KEY: v.string(),
  },
});

// @agentmail/convex 0.1.0 reads process.env.AGENTMAIL_API_KEY inside the component
// but never declares an env block in defineComponent, so the key never reaches it
// and every send fails with "AGENTMAIL_API_KEY is not set on this Convex
// deployment". Patched via patch-package to declare it; this threads it through.
app.use(agentmail, {
  env: {
    AGENTMAIL_API_KEY: app.env.AGENTMAIL_API_KEY,
  },
});
app.use(firecrawl, {
  env: {
    FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY,
  },
});
app.use(staticHosting, { httpPrefix: "/" });

export default app;
