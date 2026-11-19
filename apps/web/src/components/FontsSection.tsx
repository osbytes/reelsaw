import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FONT_FILE_EXTS, MAX_FONT_BYTES, formatBytes } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { ago } from "../lib/time";
import { cssFontFamily, useFonts } from "../lib/fonts";
import { uploadFile } from "../lib/uploads";
import { InstanceSettingsGroup } from "./InstanceSettings";
import { ScrollArea, SECTION_LIST_MAX_H } from "./scroll-area";
import { ConfirmDialog } from "./ui";

type Uploaded = { id: string; family: string; filename: string | null; sizeBytes: number | null; createdAt: string | null; createdBy: string | null };

/**
 * Settings → System → Captions: the font every caption and hook uses unless a project or clip picks another (and the
 * watermark always), and the fonts an admin uploaded for every account to pick (server: fonts.ts). Same service as
 * `list_fonts` / `add_font` / `remove_fonts` and `reelsaw fonts`.
 */
export function FontsSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const fonts = useFonts();
  const uploaded = fonts.fonts.filter((f): f is typeof f & Uploaded => !f.builtin && "id" in f && typeof f.id === "string");
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [removing, setRemoving] = useState<Uploaded | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: trpc.fonts.pathKey() });
  const add = useMutation(trpc.admin.fonts.add.mutationOptions());
  const remove = useMutation(
    trpc.admin.fonts.remove.mutationOptions({
      onSuccess: (r) => {
        if (r.removed[0]) toast(`Removed ${r.removed[0].family}. Clips that used it get the default font on their next render`);
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const onFile = async (file: File) => {
    if (file.size > MAX_FONT_BYTES) return void toast.error(`A font may be ${MAX_FONT_BYTES / 1048576} MB at most.`);
    setUploading(0);
    try {
      const uploadId = await uploadFile(file, setUploading);
      const font = await add.mutateAsync({ uploadId });
      toast(`Added ${font.family}. Every account can pick it now`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(null);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <InstanceSettingsGroup
      id="captions"
      title="Captions"
      intro="The font captions and hooks use unless a project or clip picks another; the watermark always uses it. Upload a font (your brand's, or one with the glyphs your languages need) and every account can pick it."
      fields={[{ key: "CAPTION_FONT", label: "Default caption font", kind: "enum", options: fonts.fonts.map((f) => ({ value: f.family, label: f.label })) }]}
    >
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <div className="flex items-center gap-3">
          <p className="mr-auto text-xs font-semibold text-ink2">Uploaded fonts</p>
          <input
            ref={input}
            type="file"
            accept={FONT_FILE_EXTS.join(",")}
            className="hidden"
            aria-label="Font file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          <button type="button" className="btn-ghost h-8 min-w-[7.5rem] text-xs" disabled={uploading !== null} onClick={() => input.current?.click()}>
            {uploading === null ? "Upload font…" : uploading < 1 ? `Uploading ${Math.round(uploading * 100)}%` : "Checking…"}
          </button>
        </div>
        {uploaded.length === 0 ? (
          <p className="text-xs text-ink3">
            None yet. {FONT_FILE_EXTS.join(", ")} up to {MAX_FONT_BYTES / 1048576} MB; the name comes from the file. Add the bold weight if you have one:
            captions are bold.
          </p>
        ) : (
          <ScrollArea className={SECTION_LIST_MAX_H}>
            <ul className="flex flex-col divide-y divide-line">
              {uploaded.map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-bold" style={{ fontFamily: cssFontFamily(f.family) }}>
                      {f.family}
                    </div>
                    <div className="truncate text-xs text-ink3">
                      {[f.filename, f.sizeBytes ? formatBytes(f.sizeBytes) : null, f.createdAt ? `added ${ago(f.createdAt)}` : null, f.createdBy]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <button type="button" className="btn-ghost h-8 w-20 text-xs" disabled={remove.isPending} onClick={() => setRemoving(f)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.family ?? "this font"}?`}
        body={
          fonts.defaultFamily === removing?.family
            ? "It is the default caption font: captions and the watermark go back to DejaVu Sans on their next render. Projects and clips that picked it do the same. Clips already rendered keep it. The file is deleted for good."
            : "Projects, clips and text layers that use it get the default caption font on their next render. Clips already rendered keep it. The file is deleted for good."
        }
        confirm="Remove font"
        danger
        onConfirm={() => (removing ? remove.mutateAsync({ ids: [removing.id] }) : Promise.resolve())}
      />
    </InstanceSettingsGroup>
  );
}
