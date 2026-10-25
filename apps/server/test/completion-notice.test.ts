import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { messageIdDomain, templates, type Email } from "../src/email.js";
import {
  collapseProjects,
  completionIdempotencyKey,
  readyEmail,
  greetingName,
  milestoneCrossed,
  selectUnseen,
  type DoneNotice,
} from "../src/notify/completion.js";
import { EVENT_HANDLER_DEFAULTS, defineEventHandlers, eventHandlerJobs, eventHandlerQueues, eventHandlerSetting, parseEventHandlerJob, policyOf, type EventHandlerDeps, type ReadDb } from "../src/event-handlers.js";
import { projectEventHandlers } from "../src/project-event-handlers.js";
import { PROJECT_EVENT_TYPES } from "@reelsaw/shared";
import { envSchema } from "../src/config.js";
import type { Logger } from "../src/log.js";
import type { InstanceSettings } from "../src/instance-settings.js";

const log = { debug() {}, child() { return log; } } as unknown as Logger;

function done(p: Partial<DoneNotice> & Pick<DoneNotice, "eventId" | "projectId" | "at">): DoneNotice {
  return { title: p.title ?? p.projectId, clips: p.clips ?? 2, failed: p.failed ?? 0, rerender: p.rerender ?? false, ...p };
}

describe("ready email selection", () => {
  const now = Date.parse("2026-10-25T18:00:00Z");
  const hour = 60 * 60 * 1000;

  it("keeps completions strictly after the last activity, inside the lookback", () => {
    const events = [
      done({ eventId: 1, projectId: "a", at: now - 2 * hour }),
      done({ eventId: 2, projectId: "b", at: now - 30 * 60 * 1000 }),
      done({ eventId: 3, projectId: "c", at: now - 8 * 24 * hour }),
    ];
    const unseen = selectUnseen(events, now - hour, now);
    assert.deepEqual(unseen.map((e) => e.projectId), ["b"]);
  });

  it("includes everything in the window when the account has never been stamped", () => {
    const events = [done({ eventId: 1, projectId: "a", at: now - hour })];
    assert.equal(selectUnseen(events, null, now).length, 1);
  });

  it("treats an activity stamp at the same instant as having seen it", () => {
    const at = now - hour;
    assert.equal(selectUnseen([done({ eventId: 1, projectId: "a", at })], at, now).length, 0);
  });

  it("collapses several runs of one project onto the latest, and keeps every event id", () => {
    const rows = collapseProjects([
      done({ eventId: 1, projectId: "a", at: now - 2 * hour, clips: 1, title: "Old" }),
      done({ eventId: 2, projectId: "b", at: now - hour, title: "Other" }),
      done({ eventId: 3, projectId: "a", at: now - 10 * 60 * 1000, clips: 4, failed: 1, rerender: true, title: "New" }),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { id: "a", title: "New", clips: 4, failed: 1, rerender: true, eventIds: [1, 3] });
  });
});

describe("milestones", () => {
  it("says first when the batch includes the first project, even if it also crosses a higher number", () => {
    assert.equal(milestoneCrossed(0, 1), 1);
    assert.equal(milestoneCrossed(0, 10), 1);
  });

  it("announces the highest round number a later batch crosses", () => {
    assert.equal(milestoneCrossed(9, 10), 10);
    assert.equal(milestoneCrossed(8, 26), 25);
    assert.equal(milestoneCrossed(10, 12), null);
    assert.equal(milestoneCrossed(99, 100), 100);
  });
});

describe("greeting", () => {
  it("uses the first word of a name and skips an address", () => {
    assert.equal(greetingName("Ada Lovelace"), "Ada");
    assert.equal(greetingName("  Ada  "), "Ada");
    assert.equal(greetingName("ada@example.com"), null);
    assert.equal(greetingName("  "), null);
  });
});

describe("clips ready template", () => {
  const base = { greeting: "Ada", hidden: 0, milestone: null as number | null };

  it("names the project, the clips and a link, and greets", () => {
    const mail = templates.clipsReady("https://app.example.com/", {
      ...base,
      projects: [{ id: "p1", title: "Town hall", clips: 3, failed: 1, rerender: false, highlights: ["The ask", "The demo"], more: 1 }],
    });
    assert.equal(mail.subject, "Your clips are ready");
    assert.match(mail.text, /Hi Ada/);
    assert.match(mail.text, /Town hall/);
    assert.match(mail.text, /3 clips/);
    assert.match(mail.text, /1 needs another try/);
    assert.match(mail.text, /The ask/);
    assert.match(mail.text, /and 1 more/);
    assert.match(mail.text, /https:\/\/app\.example\.com\/p\/p1/);
    assert.match(mail.html, /Open project/);
    assert.match(mail.html, /href="https:\/\/app\.example\.com\/p\/p1"/);
  });

  it("marks a first project and escapes the title", () => {
    const mail = templates.clipsReady("https://app.example.com", {
      greeting: null,
      hidden: 2,
      milestone: 1,
      projects: [{ id: "p1", title: `<SCRIPT>`, clips: 1, failed: 0, rerender: false, highlights: [], more: 0 }],
    });
    assert.equal(mail.subject, "Your first clips are ready");
    assert.match(mail.text, /first project you've finished/);
    // any case: no tag survives, only its escaped text
    assert.equal(mail.html.toLowerCase().includes("<script"), false);
    assert.ok(mail.html.includes("&lt;SCRIPT&gt;"));
    assert.match(mail.html, /And 2 more/);
    assert.match(mail.text, /https:\/\/app\.example\.com\/\n/);
  });

  it("says how many projects finished, and a later milestone", () => {
    const mail = templates.clipsReady("https://app.example.com", {
      greeting: null,
      hidden: 0,
      milestone: 10,
      projects: [
        { id: "a", title: "One", clips: 1, failed: 0, rerender: false, highlights: [], more: 0 },
        { id: "b", title: "Two", clips: 2, failed: 0, rerender: true, highlights: [], more: 0 },
      ],
    });
    assert.equal(mail.subject, "2 projects are ready");
    assert.match(mail.html, /That's 10 projects finished/);
    assert.match(mail.html, /Open projects/);
    assert.match(mail.html, /href="https:\/\/app\.example\.com\/p\/a"/);
    assert.match(mail.html, /href="https:\/\/app\.example\.com\/p\/b"/);
  });

  it("uses the new-render subject for a single re-render", () => {
    const mail = templates.clipsReady("https://app.example.com", {
      ...base,
      milestone: null,
      projects: [{ id: "p1", title: "Town hall", clips: 3, failed: 0, rerender: true, highlights: [], more: 0 }],
    });
    assert.equal(mail.subject, "A new render is ready");
    assert.match(mail.text, /new render finished/i);
  });
});

describe("ready email idempotency", () => {
  it("gives one batch the same key whatever the order, and a different batch another", () => {
    const a = completionIdempotencyKey("user-1", [3, 1, 2]);
    assert.equal(a, completionIdempotencyKey("user-1", [1, 2, 3]));
    assert.notEqual(a, completionIdempotencyKey("user-1", [1, 2]));
    assert.notEqual(a, completionIdempotencyKey("user-2", [1, 2, 3]));
    // fits Resend's key limit and a Message-ID's local part
    assert.match(a, /^ready-[0-9a-f]{40}$/);
  });

  it("puts the SMTP Message-ID on the sender's domain, else the app's host", () => {
    assert.equal(messageIdDomain("Reelsaw <no-reply@mail.example.com>", "https://app.example.com"), "mail.example.com");
    assert.equal(messageIdDomain("no-reply@example.org", "https://app.example.com"), "example.org");
    assert.equal(messageIdDomain("", "https://app.example.com/"), "app.example.com");
  });
});

describe("event handlers", () => {
  const event = { id: 1, projectId: "p1", type: "project.done" as const, payload: { projectId: "p1", clips: 2, failed: 0, runSeq: 1, runReason: "created" } };
  const db = { select: () => ({ from: () => ({ where: async () => [{ userId: "owner-1" }] }) }) } as unknown as ReadDb;
  const settings = { get: () => ({ EVENT_PROJECT_DONE_READY_EMAIL_DELAY_MINUTES: 5 }) } as unknown as InstanceSettings;
  const deps = (enabled: boolean) => ({ email: { enabled } as Email, settings }) as EventHandlerDeps;
  const handle = async () => {};

  it("lists every handler in one map, and a name twice on one event does not compile", () => {
    assert.deepEqual(eventHandlerQueues(projectEventHandlers).map((q) => q.name), ["event.project.done.readyEmail"]);
    // @ts-expect-error duplicate key in the one map
    defineEventHandlers({ "project.done": { x: { handle }, x: { handle } } });
  });

  it("names a handler's settings EVENT_<EVENT>_<HANDLER>_<NAME>, and every such setting exists", () => {
    assert.equal(eventHandlerSetting("project.done", "readyEmail", "delayMinutes"), "EVENT_PROJECT_DONE_READY_EMAIL_DELAY_MINUTES");
    assert.equal(eventHandlerSetting("clip.bumper_skipped", "notifyOwner", "DELAY_MINUTES"), "EVENT_CLIP_BUMPER_SKIPPED_NOTIFY_OWNER_DELAY_MINUTES");
    const prefixes = eventHandlerQueues(projectEventHandlers).map((q) => eventHandlerSetting(q.type, q.handler, ""));
    // EVENT_REPLAY_LIMIT and EVENT_RETENTION_DAYS are about the event log, not a handler: only EVENT_<an event type>_… counts
    const typePrefixes = PROJECT_EVENT_TYPES.map((t) => eventHandlerSetting(t, "", "").replace(/_+$/, "_"));
    const settings = Object.keys(envSchema.shape).filter((k) => typePrefixes.some((p) => k.startsWith(p)));
    assert.ok(settings.length > 0);
    for (const k of settings) assert.ok(prefixes.some((p) => k.startsWith(p)), `${k} names no registered handler`);
  });

  it("fills a handler's queue options from the defaults, overridden at the definition", () => {
    const [q] = eventHandlerQueues(projectEventHandlers);
    assert.deepEqual(q!.options, { ...EVENT_HANDLER_DEFAULTS, expireInSeconds: 120 });
  });

  it("maps the opted-in concurrency to a pg-boss policy, one queue per handler", () => {
    assert.equal(policyOf({}), "standard");
    assert.equal(policyOf({ coalesce: true }), "short");
    assert.equal(policyOf({ oneAtATime: true }), "singleton");
    assert.equal(policyOf({ coalesce: true, oneAtATime: true }), "stately");
    const qs = eventHandlerQueues(defineEventHandlers({ "project.done": { readyEmail } }));
    assert.deepEqual(qs.map((q) => [q.name, q.policy]), [["event.project.done.readyEmail", "stately"]]);
  });

  it("queues one job per handler in emit then map order, keyed by event id unless the handler keys it", async () => {
    const handlers = defineEventHandlers({
      "project.done": {
        x: { handle },
        skip: { key: () => null, handle },
        y: { key: async ({ event: e }) => `clips-${e.payload.clips}`, delaySeconds: () => 30, handle },
      },
    });
    const jobs = await eventHandlerJobs(handlers, [event, { ...event, id: 2 }], db, deps(true));
    assert.deepEqual(jobs.map((j) => [j.queue, j.data.key, j.startAfter ?? 0]), [
      ["event.project.done.x", "1", 0],
      ["event.project.done.y", "clips-2", 30],
      ["event.project.done.x", "2", 0],
      ["event.project.done.y", "clips-2", 30],
    ]);
  });

  it("parses a job's event against the schema", () => {
    assert.deepEqual(parseEventHandlerJob("project.done", { key: "k", event }), { key: "k", event });
    assert.throws(() => parseEventHandlerJob("project.done", { key: "k", event: { ...event, payload: { clips: "2" } } }));
    assert.throws(() => parseEventHandlerJob("project.failed", { key: "k", event }));
  });

  it("the ready email is keyed by the account, delayed by the setting, and skipped when email is off", async () => {
    assert.equal(await readyEmail.key!({ event, db, deps: deps(false) }), null);
    assert.equal(await readyEmail.key!({ event, db, deps: deps(true) }), "owner-1");
    assert.equal(readyEmail.delaySeconds!(deps(true)), 300);
  });
});
