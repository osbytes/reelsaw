"use client";

import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

export function CopyButton({ text, label = t(msg`Copy command`), className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className={`btn-ghost h-[30px] min-w-[84px] px-2.5 text-xs ${className}`}
      aria-label={copied ? t(msg`Copied`) : label}
      title={label}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-ok" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span>{copied ? t(msg`Copied`) : t(msg`Copy`)}</span>
    </button>
  );
}
