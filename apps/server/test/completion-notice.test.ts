import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { messageIdDomain, templates, type Email } from "../src/email.js";
import {
  collapseProjects,
  completionIdempotencyKey,
  completionNoticeHandler,
  greetingName,
  milestoneCrossed,
  scheduleCompletionNotify,
  selectUnseen,
  type DoneNotice,
} from "../src/notify/completion.js";
import { createEventHandlers } from "../src/event-handlers.js";
import { COMPLETION_NOTIFY_QUEUE } from "../src/queue/boss.js";
import type { Logger } from "../src/log.js";
import type { UnitOfWork } from "../src/uow.js";
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

describe("scheduleCompletionNotify", () => {
  it("does not queue when email is off", async () => {
    let called = false;
    const r = await scheduleCompletionNotify({
      emailEnabled: false,
      delayMinutes: 20,
      log,
      send: async () => {
        called = true;
        return "job";
      },
    }, "user-1");
    assert.equal(r, "off");
    assert.equal(called, false);
  });

  it("queues one delayed job per account, and a null send is the debounce", async () => {
    const calls: Array<{ queue: string; data: object; opts?: { singletonKey?: string; startAfter?: number } }> = [];
    const send = async (queue: string, data: object, opts?: { singletonKey?: string; startAfter?: number }) => {
      calls.push({ queue, data, opts });
      return calls.length === 1 ? "job-1" : null;
    };
    const first = await scheduleCompletionNotify({ emailEnabled: true, delayMinutes: 20, log, send }, "user-1");
    const second = await scheduleCompletionNotify({ emailEnabled: true, delayMinutes: 20, log, send }, "user-1");
    assert.equal(first, "queued");
    assert.equal(second, "already");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.queue, COMPLETION_NOTIFY_QUEUE);
    assert.deepEqual(calls[0]!.data, { userId: "user-1" });
    assert.equal(calls[0]!.opts?.singletonKey, "user-1");
    assert.equal(calls[0]!.opts?.startAfter, 20 * 60);
    assert.equal(calls[1]!.opts?.startAfter, 20 * 60);
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
  it("lists handlers for a type in registration order, and refuses a duplicate name", () => {
    const h = createEventHandlers();
    const noop = async () => {};
    h.on("project.done", "a", noop);
    h.on("project.done", "b", noop);
    assert.deepEqual(h.of("project.done").map((x) => x.name), ["a", "b"]);
    assert.equal(h.of("project.failed").length, 0);
    assert.throws(() => h.on("project.done", "a", noop));
  });

  it("queues the ready note on the emitting unit of work, and nothing when email is off", async () => {
    const sent: Array<{ queue: string; opts?: { singletonKey?: string; startAfter?: number } }> = [];
    const u = {
      db: { select: () => ({ from: () => ({ where: async () => [{ userId: "owner-1" }] }) }) },
      send: async (queue: string, _data: object, opts?: { singletonKey?: string; startAfter?: number }) => {
        sent.push({ queue, opts });
        return "job";
      },
    } as unknown as UnitOfWork;
    const settings = { get: () => ({ COMPLETION_NOTIFY_MINUTES: 5 }) } as unknown as InstanceSettings;
    const event = { id: 1, projectId: "p1", type: "project.done" as const, payload: {} };
    await completionNoticeHandler({ email: { enabled: false } as Email, settings, log })(u, event);
    assert.equal(sent.length, 0);
    await completionNoticeHandler({ email: { enabled: true } as Email, settings, log })(u, event);
    assert.deepEqual(sent, [{ queue: COMPLETION_NOTIFY_QUEUE, opts: { singletonKey: "owner-1", startAfter: 300 } }]);
  });
});
