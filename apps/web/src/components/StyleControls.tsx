import { defaultStyle, type Style } from "@reelsaw/shared";

const CAPTION_STYLES: Array<{ value: Style["captions"]; label: string }> = [
  { value: "karaoke", label: "Highlight" },
  { value: "box", label: "Boxed" },
  { value: "plain", label: "Outline" },
  { value: "none", label: "Off" },
];
const SWATCHES = ["#FFD700", "#39FF14", "#00E5FF", "#FF4D6D", "#FFFFFF"];

export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string; title?: string }>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex flex-wrap gap-0.5 rounded-md border border-border bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-1 text-xs transition ${o.value === value ? "bg-panel text-text shadow" : "text-muted hover:text-text"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Caption + hook appearance. Position is set by dragging on the preview; these are the rest. */
export function StyleControls({ style, onChange }: { style: Style; onChange: (patch: Partial<Style>) => void }) {
  const captionsOn = style.captions !== "none";
  return (
    <div className="space-y-4">
      <div>
        <label className="label">Captions</label>
        <Segmented value={style.captions} options={CAPTION_STYLES} onChange={(v) => onChange({ captions: v })} />
      </div>

      {captionsOn && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Size · {Math.round(style.captionSize * 100)}%</label>
              <input className="w-full accent-[var(--color-accent)]" type="range" min={0.5} max={2} step={0.05} value={style.captionSize} onChange={(e) => onChange({ captionSize: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label">Words on screen · {style.wordsPerLine}</label>
              <input className="w-full accent-[var(--color-accent)]" type="range" min={1} max={8} step={1} value={style.wordsPerLine} onChange={(e) => onChange({ wordsPerLine: Number(e.target.value) })} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {style.captions === "karaoke" && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted">Highlight</span>
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onChange({ highlightColor: c })}
                    className={`h-5 w-5 rounded-full border ${style.highlightColor.toUpperCase() === c ? "border-text ring-2 ring-accent-2" : "border-border"}`}
                    style={{ background: c }}
                    aria-label={`Highlight ${c}`}
                  />
                ))}
                <input type="color" className="h-5 w-6 cursor-pointer rounded border border-border bg-transparent" value={style.highlightColor} onChange={(e) => onChange({ highlightColor: e.target.value.toUpperCase() })} title="Custom colour" />
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <label className="flex items-center gap-2 text-sm" title="Colour the key words the AI picks for each clip (editable per clip)">
                <input type="checkbox" checked={style.emphasis} onChange={(e) => onChange({ emphasis: e.target.checked })} /> Key words
              </label>
              {style.emphasis && (
                <input type="color" className="h-5 w-6 cursor-pointer rounded border border-border bg-transparent" value={style.emphasisColor} onChange={(e) => onChange({ emphasisColor: e.target.value.toUpperCase() })} title="Key word colour" />
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={style.uppercase} onChange={(e) => onChange({ uppercase: e.target.checked })} /> UPPERCASE
            </label>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={style.showHook} onChange={(e) => onChange({ showHook: e.target.checked })} /> Hook overlay
        </label>
        {style.showHook && (
          <label className="flex items-center gap-2 text-xs text-muted">
            for
            <input className="input w-16 px-2 py-1" type="number" min={1} max={15} step={0.5} value={style.hookSeconds} onChange={(e) => onChange({ hookSeconds: Number(e.target.value) })} />
            seconds
          </label>
        )}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => onChange({ captionX: defaultStyle.captionX, captionY: defaultStyle.captionY, hookX: defaultStyle.hookX, hookY: defaultStyle.hookY })}>
          Reset positions
        </button>
        <span className="self-center text-muted">Drag captions and hook on the preview to move them.</span>
      </div>
    </div>
  );
}
