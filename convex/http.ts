import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { agentmail } from "./email";

const http = httpRouter();

// Mounted under the app httpPrefix "/api", so the URL to register with AgentMail is
// https://<deployment>.convex.site/api/agentmail/webhook
http.route({
  path: "/agentmail/webhook",
  method: "POST",
  // @agentmail/convex 0.1.0 pins an older Convex type for RunMutationCtx. convex
  // 1.46 added an optional options argument to runMutation, which is additive at
  // runtime but breaks structural assignability. Cast to exactly the parameter the
  // component declares rather than to any, so a genuine signature change still fails.
  handler: httpAction(async (ctx, req) =>
    agentmail.handleWebhook(
      ctx as unknown as Parameters<typeof agentmail.handleWebhook>[0],
      req,
    ),
  ),
});

export default http;
