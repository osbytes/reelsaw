import { useEffect, useRef } from "react";

type Provider = "cloudflare-turnstile" | "google-recaptcha" | "hcaptcha";
const SCRIPT: Record<Provider, string> = {
  "cloudflare-turnstile": "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  "google-recaptcha": "https://www.google.com/recaptcha/api.js?render=explicit",
  hcaptcha: "https://js.hcaptcha.com/1/api.js?render=explicit",
};

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => string; reset: (id: string) => void };
    grecaptcha?: { ready: (cb: () => void) => void; render: (el: HTMLElement, o: Record<string, unknown>) => number; reset: (id: number) => void };
    hcaptcha?: { render: (el: HTMLElement, o: Record<string, unknown>) => string; reset: (id: string) => void };
  }
}

/** Renders the configured captcha widget; `onToken` receives the response the sign-in/up request must send as x-captcha-response. */
export function Captcha({ provider, siteKey, onToken }: { provider: Provider; siteKey: string; onToken: (t: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const render = () => {
      if (cancelled || el.childElementCount) return;
      const cb = (t: string) => onToken(t);
      const expired = () => onToken(null);
      if (provider === "cloudflare-turnstile")
        window.turnstile?.render(el, { sitekey: siteKey, callback: cb, "expired-callback": expired, "error-callback": expired });
      else if (provider === "hcaptcha") window.hcaptcha?.render(el, { sitekey: siteKey, callback: cb, "expired-callback": expired });
      else window.grecaptcha?.ready(() => window.grecaptcha?.render(el, { sitekey: siteKey, callback: cb, "expired-callback": expired }));
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT[provider]}"]`);
    if (existing && (window.turnstile || window.grecaptcha || window.hcaptcha)) render();
    else {
      const s = existing ?? document.createElement("script");
      if (!existing) {
        s.src = SCRIPT[provider];
        s.async = true;
        document.head.appendChild(s);
      }
      s.addEventListener("load", render);
    }
    return () => {
      cancelled = true;
    };
  }, [provider, siteKey, onToken]);
  return <div ref={ref} className="min-h-[65px]" />;
}
