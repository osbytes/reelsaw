import assert from "node:assert/strict";
import { test } from "node:test";
import { msg, plural } from "@lingui/core/runtime-macro";
import { formatDay, formatNumber } from "@reelsaw/shared";
import { AppError, currentLocale, errorMessageData, requestLocale, scopeAccount, t, withLocale } from "../src/i18n.js";

test("a message renders in English with its values and plurals", () => {
  const title = "Talk";
  assert.equal(t(msg`Project ${{ title }} is ready`), "Project Talk is ready");
  const n = 3;
  assert.equal(t(msg({ id: "test.clips", message: plural({ n }, { one: "# clip", other: "# clips" }) })), "3 clips");
});

test("an AppError carries a stable code and its parameters beside the sentence", () => {
  const id = "p1";
  const err = new AppError("NOT_FOUND", msg({ id: "test.not_found", message: msg`No project ${{ id }}` }));
  assert.equal(err.code, "NOT_FOUND");
  assert.equal(err.message, "No project p1");
  assert.deepEqual(errorMessageData(err), { messageId: "test.not_found", params: { id: "p1" } });
});

test("the request locale: header, then Accept-Language, then English; the account refines it", () => {
  assert.equal(requestLocale(new Headers({ "x-reelsaw-locale": "en-XA" })).locale, "en-XA");
  assert.equal(requestLocale(new Headers({ "accept-language": "fr-CA, en-GB;q=0.8" })).locale, "en");
  assert.equal(requestLocale(new Headers({ "accept-language": "zz" })).locale, "en");
  withLocale("en", null, () => {
    scopeAccount({ locale: "en-XA", timeZone: "Europe/Berlin" });
    // a scope set explicitly (the header, a job) keeps its locale; the zone follows the account
    assert.equal(currentLocale(), "en");
  });
});

test("formatting follows the scope's locale", () => {
  withLocale("en", "UTC", () => {
    assert.equal(formatNumber(1200), "1,200");
    assert.equal(formatDay("2026-12-18T12:00:00Z", { utc: true }), "December 18, 2026");
  });
});
