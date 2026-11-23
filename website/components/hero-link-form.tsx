"use client";

import { msg } from "@lingui/core/runtime-macro";
import { t, rich } from "@/lib/i18n";
// The hero's call to action: paste a link, land on sign-up, and find the link waiting on the New project
// page after the first sign-in (the app's Login.tsx remembers `?url=`). A plain GET form, so it works before
// hydration and without JavaScript; with it, the link is tidied ("youtube.com/…" gets https://) and an empty
// box goes to plain sign-up.

import { ArrowRight, Link2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { siteDistinctId } from "@/components/analytics";
import { decorateAppUrl } from "@/lib/attribution";
import { SITE, SOURCE_URL_PARAM, appLink, utmParams } from "@/lib/site";

const CTA = "home_hero";

/** A pasted link with a scheme, or null when it cannot be a web page. The app checks again (normalizeSourceUrl). */
function tidy(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
}

export function HeroLinkForm() {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!value.trim()) return window.location.assign(decorateAppUrl(appLink("/signup", CTA), siteDistinctId()));
    const url = tidy(value);
    if (!url) return setInvalid(true);
    window.location.assign(decorateAppUrl(appLink("/signup", CTA, { [SOURCE_URL_PARAM]: url }), siteDistinctId()));
  };

  return (
    <div className="flex w-full max-w-[600px] flex-col items-center gap-3 lg:items-start">
      <form action={`${SITE.app}/signup`} method="get" onSubmit={submit} noValidate className="w-full">
        {Object.entries(utmParams(CTA)).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <div
          className={`flex h-14 w-full items-center gap-2 rounded-[14px] border bg-panel p-1.5 pl-4 shadow-pop transition focus-within:border-acc ${invalid ? "border-err" : "border-line"}`}
        >
          <Link2 className="h-4 w-4 shrink-0 text-ink3" aria-hidden />
          <input
            name={SOURCE_URL_PARAM}
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setInvalid(false);
            }}
            placeholder={t(msg`Paste a YouTube link`)}
            aria-label={t(msg`Link to a video`)}
            aria-invalid={invalid}
            aria-describedby="hero-link-hint"
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink3"
          />
          <button type="submit" className="btn-primary h-full shrink-0 px-4 text-[15px]">
            <span className="sm:hidden">{t(msg`Clip it`)}</span>
            <span className="hidden sm:inline">{t(msg`Clip it free`)}</span>
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </form>
      {/* One line, always there: the error takes the hint's place, so nothing below moves */}
      <p id="hero-link-hint" aria-live="polite" className={`text-center text-sm lg:text-left ${invalid ? "text-err" : "text-ink3"}`}>
        {invalid
          ? t(msg`Not a link yet: paste the video's address, like youtube.com/watch?v=…`)
          : rich(msg`Your first video free, up to 60 minutes. No card. <0>Or upload a file</0>`, {
              0: (c) => (
                <a href={appLink("/signup", "home_hero_upload")} className="prose-link">
                  {c}
                </a>
              ),
            })}
      </p>
    </div>
  );
}
