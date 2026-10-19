import { Kbd, Modal } from "./ui";
import { ScrollArea } from "./scroll-area";
import { useShortcutGroups } from "../lib/shortcuts";

/** The `?` sheet: every shortcut the current screen has registered, grouped by view. */
export function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const groups = useShortcutGroups();
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" width={460}>
      <ScrollArea className="max-h-[min(60vh,calc(90vh-8rem))]">
        <div className="flex flex-col gap-4 text-[13px]">
          {groups.map((g) => (
            <section key={g.scope} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink3">{g.scope}</h3>
              {g.items.map(([label, keys]) => (
                <div key={label} className="flex items-center justify-between gap-4">
                  <span className="text-ink2">{label}</span>
                  <Kbd>{keys}</Kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </ScrollArea>
    </Modal>
  );
}
