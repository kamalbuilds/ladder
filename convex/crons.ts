import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// The clocks are weeks long, so this does not need to be frequent. It needs to be
// reliable, which is the point: the whole product is that nobody is watching the
// date except this.
crons.interval(
  "sweep expired escalation clocks",
  { minutes: 5 },
  internal.escalate.sweepExpiredClocks,
  {},
);

// Organisations rewrite their complaints procedure without telling anyone, and the
// deadline you were relying on moves with it. Small batches on purpose.
crons.interval(
  "re-read the pages each ladder was built from",
  { hours: 6 },
  internal.watch.sweepWatches,
  {},
);

export default crons;
