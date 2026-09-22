import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const TOKEN_KEY = "ladder.token";

function remaining(dueAt: number | undefined, now: number) {
  if (!dueAt) return null;
  const ms = dueAt - now;
  const over = ms < 0;
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86400000);
  const h = Math.floor((abs % 86400000) / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
  return { over, text };
}

const KIND_LABEL: Record<string, string> = {
  substantive_answer: "actually answered",
  holding_acknowledgement: "holding reply",
  final_response: "final response",
  fob_off: "fob-off",
  auto_reply: "autoresponder",
  unrelated: "unrelated",
};

const clean = (err: unknown) =>
  String(err)
    .replace(/^.*?Error:\s*/s, "")
    .replace(/\s+at\s+handler[\s\S]*$/, "")
    .slice(0, 160);

export default function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem(TOKEN_KEY) ?? "",
  );
  const [selected, setSelected] = useState<Id<"cases"> | null>(null);
  const me = useQuery(api.auth.me, { token: token || undefined });
  const signOut = useMutation(api.auth.signOut);

  const setSession = (t: string) => {
    localStorage.setItem(TOKEN_KEY, t);
    setToken(t);
  };

  const clearSession = async () => {
    if (token) await signOut({ token }).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setSelected(null);
  };

  if (token && me === undefined) return <Splash />;
  if (!me) return <Gate onSession={setSession} />;

  return (
    <div className="wrap">
      <header className="top">
        <h1>Ladder</h1>
        <p>Find who regulates them. Watch the clock. Escalate on time.</p>
        <p className="mono disclaimer">
          Ladder is not a law firm and gives no legal advice. It reports what
          official pages say and links every one.
        </p>
      </header>

      <div className="cols">
        <div>
          {selected ? (
            <Board
              token={token}
              caseId={selected}
              onBack={() => setSelected(null)}
            />
          ) : (
            <NewCase token={token} onCreated={setSelected} />
          )}
        </div>
        <div>
          <Cases
            token={token}
            selected={selected}
            onSelect={setSelected}
            onNew={() => setSelected(null)}
          />
          <p className="mono signedin">
            Signed in as {me.email}
            <button className="linkish" onClick={clearSession}>
              sign out
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="wrap" style={{ maxWidth: 520, paddingTop: 90 }}>
      <header className="top">
        <h1>Ladder</h1>
      </header>
      <p className="empty">Checking your session.</p>
    </div>
  );
}

function Gate({ onSession }: { onSession: (t: string) => void }) {
  const requestCode = useMutation(api.auth.requestCode);
  const verifyCode = useMutation(api.auth.verifyCode);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <div className="wrap" style={{ maxWidth: 520, paddingTop: 90 }}>
      <header className="top">
        <h1>Ladder</h1>
      </header>
      <p style={{ marginTop: 0 }}>
        When an organisation stops replying, the thing that beats you is not the
        argument. It is the calendar, and not knowing who above them is obliged
        to listen.
      </p>

      {stage === "email" ? (
        <form
          className="new"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await requestCode({ email: email.trim() });
              setStage("code");
            } catch (err) {
              setError(clean(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            <span>Your email</span>
            <input
              type="email"
              required
              value={email}
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {error && <p className="err mono">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? "Sending" : "Email me a code"}
          </button>
        </form>
      ) : (
        <form
          className="new"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const r = await verifyCode({
                email: email.trim(),
                code: code.trim(),
              });
              onSession(r.token);
            } catch (err) {
              setError(clean(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="mono" style={{ marginTop: 0, color: "var(--dim)" }}>
            Six digits, sent to {email}. It lasts ten minutes.
          </p>
          <label>
            <span>Code</span>
            <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              placeholder="000000"
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          {error && <p className="err mono">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? "Checking" : "Sign in"}
          </button>{" "}
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setStage("email");
              setCode("");
              setError("");
            }}
          >
            Different email
          </button>
        </form>
      )}
    </div>
  );
}

function Cases({
  token,
  selected,
  onSelect,
  onNew,
}: {
  token: string;
  selected: Id<"cases"> | null;
  onSelect: (id: Id<"cases">) => void;
  onNew: () => void;
}) {
  const cases = useQuery(api.cases.list, { token });
  return (
    <>
      <h2 className="sec">Your cases</h2>
      {cases === undefined && <p className="empty">Loading.</p>}
      {cases?.length === 0 && (
        <p className="empty">
          Nothing yet. Describe the first one and Ladder will go and find out who
          regulates them.
        </p>
      )}
      <div className="caselist">
        {cases?.map((c) => (
          <button
            key={c._id}
            aria-current={selected === c._id}
            onClick={() => onSelect(c._id)}
          >
            {c.title}
            <br />
            <span className="mono" style={{ color: "var(--dim)" }}>
              {c.counterparty} · {c.status.replace(/_/g, " ")}
              {c.sharedWithMe ? " · shared with you" : ""}
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <p style={{ marginTop: 22 }}>
          <button className="ghost" onClick={onNew}>
            New case
          </button>
        </p>
      )}
    </>
  );
}

function NewCase({
  token,
  onCreated,
}: {
  token: string;
  onCreated: (id: Id<"cases">) => void;
}) {
  const create = useMutation(api.cases.create);
  const [title, setTitle] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [url, setUrl] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <>
      <h2 className="sec">Who has gone quiet on you</h2>
      <form
        className="new"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const id = await create({
              token,
              title: title.trim(),
              counterparty: counterparty.trim(),
              counterpartyUrl: url.trim() || undefined,
              summary: summary.trim() || undefined,
            });
            onCreated(id);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          <span>What is it about</span>
          <input
            required
            value={title}
            placeholder="Damp and mould, no inspection arranged"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          <span>Who is ignoring you</span>
          <input
            required
            value={counterparty}
            placeholder="Hastings Letting Agents"
            onChange={(e) => setCounterparty(e.target.value)}
          />
        </label>
        <label>
          <span>Their website, if you have it</span>
          <input
            value={url}
            placeholder="https://..."
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label>
          <span>What has happened so far</span>
          <textarea
            rows={4}
            value={summary}
            placeholder="Wrote to them with photos on 6 January citing the Homes (Fitness for Human Habitation) Act. No inspection arranged, no meaningful reply since."
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Working" : "Map the ladder"}
        </button>
      </form>
    </>
  );
}

function Board({
  token,
  caseId,
  onBack,
}: {
  token: string;
  caseId: Id<"cases">;
  onBack: () => void;
}) {
  const data = useQuery(api.cases.board, { token, caseId });
  const pack = useQuery(api.cases.evidencePack, { token, caseId });
  const fastForward = useMutation(api.cases.fastForwardClock);
  const recheck = useMutation(api.cases.recheckSources);
  const share = useMutation(api.cases.share);
  const unshare = useMutation(api.cases.unshare);
  const [now, setNow] = useState(Date.now());
  const [showPack, setShowPack] = useState(false);
  const [invite, setInvite] = useState("");
  const [shareErr, setShareErr] = useState("");

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (data === undefined) return <p className="empty">Loading.</p>;
  if (data === null) return <p className="empty">That case is gone.</p>;

  const { case: kase, rungs, findings, messages, watches, members, role } = data;
  const hasClock = rungs.some((r) => r.state === "active" && r.dueAt);
  const moved = (watches ?? []).filter((w) => w.lastChangedAt);

  const downloadPack = () => {
    if (!pack) return;
    const blob = new Blob([pack.markdown], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = pack.filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <h2 className="sec">
        {kase.counterparty} · {kase.status.replace(/_/g, " ")}
        {role === "collaborator" ? " · shared with you" : ""}
      </h2>

      {kase.inboxEmail && (
        <div className="inbox">
          <div className="mono" style={{ color: "var(--dim)" }}>
            THIS CASE'S INBOX — forward their replies here, or email it yourself
            to watch Ladder read it
          </div>
          <strong className="mono" style={{ fontSize: 14 }}>
            {kase.inboxEmail}
          </strong>
        </div>
      )}

      {kase.working && (
        <p className="working mono" style={{ marginTop: 0 }}>
          {kase.working}
        </p>
      )}

      {rungs.length === 0 && !kase.working && (
        <p className="empty">No ladder yet.</p>
      )}

      <div className="ladder">
        {rungs.map((r) => {
          const rem = remaining(r.dueAt ?? undefined, now);
          return (
            <div key={r._id} className={`rung ${r.state}`}>
              <h3>{r.name}</h3>
              <p className="authority">{r.authority}</p>
              <p className="action">{r.action}</p>
              {r.contact && (
                <p className="mono" style={{ margin: "0 0 6px" }}>
                  → {r.contact}
                </p>
              )}
              {rem && (
                <span
                  className={`clock mono ${rem.over ? "over" : "live"}`}
                  title={r.clockLabel ?? ""}
                >
                  <strong>{rem.over ? `${rem.text} OVERDUE` : rem.text}</strong>
                  {r.clockLabel && <em>{r.clockLabel}</em>}
                </span>
              )}
              {!rem && r.clockLabel && (
                <span className="clock mono">{r.clockLabel}</span>
              )}
              {r.sourceUrl && (
                <a
                  className="src mono"
                  href={r.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.sourceUrl}
                </a>
              )}
            </div>
          );
        })}
      </div>

      <p style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
        <button className="ghost" onClick={onBack}>
          Back
        </button>
        {hasClock && (
          <button
            className="ghost"
            onClick={() => fastForward({ token, caseId })}
            title="The real windows are weeks long. This winds the current one past its deadline so you can watch what Ladder does when it runs out."
          >
            Wind the clock past its deadline
          </button>
        )}
        <button
          className="ghost"
          onClick={() => recheck({ token, caseId })}
          title="Re-reads the pages this ladder was built from and reports anything that moved."
        >
          Re-read the sources
        </button>
        <button className="ghost" onClick={() => setShowPack((s) => !s)}>
          {showPack ? "Hide evidence pack" : "Evidence pack"}
        </button>
      </p>

      {showPack && (
        <div className="pack">
          <div className="packhead">
            <span className="mono">{pack ? pack.filename : "building…"}</span>
            <button onClick={downloadPack} disabled={!pack}>
              Download
            </button>
          </div>
          <pre className="mono">{pack?.markdown ?? ""}</pre>
        </div>
      )}

      <h2 className="sec" style={{ marginTop: 38 }}>
        Who else can see this
      </h2>
      {(members ?? []).length === 0 && (
        <p className="empty">
          Only you. Invite whoever is helping you and they see this board update
          live.
        </p>
      )}
      {(members ?? []).map((m) => (
        <p key={m._id} className="mono member">
          {m.email}
          <span style={{ color: "var(--dim)" }}> · {m.role}</span>
          {role === "owner" && (
            <button
              className="linkish"
              onClick={() => unshare({ token, memberId: m._id })}
            >
              remove
            </button>
          )}
        </p>
      ))}
      {role === "owner" && (
        <form
          className="inviteform"
          onSubmit={async (e) => {
            e.preventDefault();
            setShareErr("");
            try {
              await share({ token, caseId, email: invite.trim() });
              setInvite("");
            } catch (err) {
              setShareErr(clean(err));
            }
          }}
        >
          <input
            type="email"
            required
            value={invite}
            placeholder="caseworker@citizensadvice.org.uk"
            onChange={(e) => setInvite(e.target.value)}
          />
          <button type="submit">Invite</button>
        </form>
      )}
      {shareErr && <p className="err mono">{shareErr}</p>}

      {(watches ?? []).length > 0 && (
        <>
          <h2 className="sec" style={{ marginTop: 38 }}>
            Pages Ladder is watching
          </h2>
          {(watches ?? []).map((w) => (
            <div
              className={`finding${w.changeMatters ? " alert" : ""}`}
              key={w._id}
            >
              <p className="claim">
                {w.label}
                {w.lastChangedAt ? (
                  <strong>
                    {" "}
                    changed {new Date(w.lastChangedAt).toLocaleDateString()}
                  </strong>
                ) : (
                  <span style={{ color: "var(--dim)" }}> no change</span>
                )}
              </p>
              {w.changeSummary && <blockquote>{w.changeSummary}</blockquote>}
              <a
                className="src mono"
                href={w.url}
                target="_blank"
                rel="noreferrer"
              >
                {w.url}
              </a>
            </div>
          ))}
          {moved.length === 0 && (
            <p className="empty">
              Checked every six hours. If one of these pages rewrites a deadline
              or names a different ombudsman, it shows up here and in the
              evidence pack.
            </p>
          )}
        </>
      )}

      {findings.length > 0 && (
        <>
          <h2 className="sec" style={{ marginTop: 38 }}>
            What Ladder read, and where
          </h2>
          {findings.map((f) => (
            <div className="finding" key={f._id}>
              <p className="claim">{f.claim}</p>
              {f.quote && <blockquote>“{f.quote}”</blockquote>}
              <a
                className="src mono"
                href={f.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {f.sourceUrl}
              </a>
            </div>
          ))}
        </>
      )}

      <h2 className="sec" style={{ marginTop: 38 }}>
        Correspondence
      </h2>
      {messages.length === 0 && (
        <p className="empty">
          Nothing yet. Anything sent to the inbox above lands here, read and
          labelled.
        </p>
      )}
      {messages.map((m) => (
        <div className="msg" key={m._id}>
          <div className="head">
            <span className="mono" style={{ color: "var(--dim)" }}>
              {m.direction === "inbound" ? "IN" : "OUT"}
            </span>
            <strong style={{ fontSize: 15 }}>{m.subject}</strong>
            {m.replyKind && (
              <span className={`tag mono ${m.replyKind}`}>
                {KIND_LABEL[m.replyKind] ?? m.replyKind}
              </span>
            )}
            <span className="mono" style={{ color: "var(--dim)" }}>
              {new Date(m.receivedAt).toLocaleString()}
            </span>
          </div>
          {m.replyReason && <p className="why">{m.replyReason}</p>}
        </div>
      ))}
    </>
  );
}
