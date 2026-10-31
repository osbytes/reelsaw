import { toast } from "sonner";

/**
 * When the browser refuses the clipboard (permissions, an embedded browser, an insecure origin), the text is shown in a
 * toast that stays until closed, selected, so the person can copy it themselves instead of losing it to an error.
 */
export function showTextToCopy(text: string, why = "Your browser didn’t allow copying.") {
  toast(
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <span>{why} Copy it from here:</span>
      <input
        readOnly
        aria-label="Text to copy"
        className="input w-full font-mono text-xs"
        value={text}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => e.currentTarget.select()}
      />
    </div>,
    { duration: Number.POSITIVE_INFINITY, closeButton: true },
  );
}

/** Copy, then say so; when the clipboard is refused, show the text to copy by hand. */
export function copyText(text: string, done: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast(done))
    .catch(() => showTextToCopy(text));
}
