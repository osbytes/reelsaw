import { useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FONT_FILE_EXTS, MAX_FONT_BYTES, formatBytes, formatNumber, formatPercent } from "@reelsaw/shared";
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
  const { t } = useLingui();
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
        const family = r.removed[0]?.family;
        if (family) toast(t`Removed ${family}. Clips that used it get the default font on their next render`);
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const addedAgo = (at: string) => {
    const when = ago(at);
    return t`added ${when}`;
  };

  const onFile = async (file: File) => {
    if (file.size > MAX_FONT_BYTES) return void toast.error(t`A font may be ${maxMb} MB at most.`);
    setUploading(0);
    try {
      const uploadId = await uploadFile(file, setUploading);
      const font = await add.mutateAsync({ uploadId });
      const family = font.family;
      toast(t`Added ${family}. Every account can pick it now`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(null);
      if (input.current) input.current.value = "";
    }
  };

  const maxMb = formatNumber(MAX_FONT_BYTES / 1048576);
  const exts = FONT_FILE_EXTS.join(", ");
  const removingFamily = removing?.family ?? t`this font`;

  return (
    <InstanceSettingsGroup
      id="captions"
      title={t`Captions`}
      intro={t`The font captions and hooks use unless a project or clip picks another; the watermark always uses it. Upload a font (your brand's, or one with the glyphs your languages need) and every account can pick it.`}
      fields={[{ key: "CAPTION_FONT", label: t`Default caption font`, kind: "enum", options: fonts.fonts.map((f) => ({ value: f.family, label: f.label })) }]}
    >
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <div className="flex items-center gap-3">
          <p className="me-auto text-xs font-semibold text-ink2">
            <Trans>Uploaded fonts</Trans>
          </p>
          <input
            ref={input}
            type="file"
            accept={FONT_FILE_EXTS.join(",")}
            className="hidden"
            aria-label={t`Font file`}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          <button type="button" className="btn-ghost h-8 min-w-[7.5rem] text-xs" disabled={uploading !== null} onClick={() => input.current?.click()}>
            {uploading === null ? <Trans>Upload font…</Trans> : uploading < 1 ? <Trans>Uploading {formatPercent(uploading)}</Trans> : <Trans>Checking…</Trans>}
          </button>
        </div>
        {uploaded.length === 0 ? (
          <p className="text-xs text-ink3">
            <Trans>
              None yet. {exts} up to {maxMb} MB; the name comes from the file. Add the bold weight if you have one: captions are bold.
            </Trans>
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
                      {[f.filename, f.sizeBytes ? formatBytes(f.sizeBytes) : null, f.createdAt ? addedAgo(f.createdAt) : null, f.createdBy]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <button type="button" className="btn-ghost h-8 w-20 text-xs" disabled={remove.isPending} onClick={() => setRemoving(f)}>
                    <Trans>Remove</Trans>
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
        title={t`Remove ${removingFamily}?`}
        body={
          fonts.defaultFamily === removing?.family
            ? t`It is the default caption font: captions and the watermark go back to DejaVu Sans on their next render. Projects and clips that picked it do the same. Clips already rendered keep it. The file is deleted for good.`
            : t`Projects, clips and text layers that use it get the default caption font on their next render. Clips already rendered keep it. The file is deleted for good.`
        }
        confirm={t`Remove font`}
        danger
        onConfirm={() => (removing ? remove.mutateAsync({ ids: [removing.id] }) : Promise.resolve())}
      />
    </InstanceSettingsGroup>
  );
}
