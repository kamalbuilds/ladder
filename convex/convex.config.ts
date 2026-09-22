import { defineApp } from "convex/server";
import agentmail from "@agentmail/convex/convex.config";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// Our own http.ts routes live under /api so static hosting can own "/".
// Firecrawl is mounted without an httpPrefix on purpose: we only use scrape and
// search, which return inline in an action, so there is no crawl webhook to route.
// That sidesteps the undocumented precedence question between a component at "/"
// and a component at "/firecrawl/".
const app = defineApp({ httpPrefix: "/api" });

app.use(agentmail);
app.use(firecrawl);
app.use(staticHosting, { httpPrefix: "/" });

export default app;
