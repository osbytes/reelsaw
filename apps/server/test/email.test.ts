import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { layout, templates } from "../src/email.js";

describe("email templates", () => {
  it("verifyEmail includes a confirm CTA and the raw link in both parts", () => {
    const url = "https://app.example.com/api/auth/verify-email?token=abc";
    const mail = templates.verifyEmail(url);
    assert.equal(mail.subject, "Confirm your email for Reelsaw");
    assert.match(mail.text, /Confirm this address/);
    assert.match(mail.text, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(mail.html, /Confirm email/);
    assert.match(mail.html, /href="https:\/\/app\.example\.com\/api\/auth\/verify-email\?token=abc"/);
    assert.match(mail.html, /reel<span[^>]*>\/<\/span>saw/);
  });

  it("resetPassword keeps the ignore-if-not-you line", () => {
    const mail = templates.resetPassword("https://app.example.com/reset?token=x");
    assert.match(mail.text, /If not, ignore/);
    assert.match(mail.html, /Reset password/);
    assert.match(mail.html, /didn't ask for this/);
  });

  it("approved and waitingForApproval point at the app", () => {
    const ready = templates.approved("https://app.example.com/");
    assert.match(ready.html, /href="https:\/\/app\.example\.com\/login"/);
    assert.match(ready.text, /https:\/\/app\.example\.com\/login/);

    const wait = templates.waitingForApproval("https://app.example.com", "Ada", "ada@example.com");
    assert.match(wait.subject, /Ada/);
    assert.match(wait.html, /Ada \(ada@example\.com\)/);
    assert.match(wait.html, /href="https:\/\/app\.example\.com\/admin\/users"/);
  });

  it("escapes HTML in the waiting-for-approval name and email", () => {
    const mail = templates.waitingForApproval("https://app.example.com", `<script>x</script>`, `a"b@c.com`);
    assert.doesNotMatch(mail.html, /<script>/);
    assert.match(mail.html, /&lt;script&gt;/);
    assert.match(mail.html, /a&quot;b@c\.com/);
  });

  it("layout wraps content in a branded card with a source link", () => {
    const html = layout({ preheader: "Peek", title: "Hello", bodyHtml: "<p>Hi</p>" });
    assert.match(html, /Peek/);
    assert.match(html, /Hello/);
    assert.match(html, /<p>Hi<\/p>/);
    assert.match(html, /No tracking/);
    assert.match(html, /href="https:\/\/github\.com\/osbytes\/reelsaw"/);
  });

  it("plain text includes the source repository", () => {
    const mail = templates.verifyEmail("https://app.example.com/v");
    assert.match(mail.text, /https:\/\/github\.com\/osbytes\/reelsaw/);
  });
});
