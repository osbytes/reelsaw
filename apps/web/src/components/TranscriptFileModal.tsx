import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./ui";
import { useTRPC } from "../lib/trpc";
import { uploadFile } from "../lib/uploads";

/** Get the transcript as SRT / VTT, or replace it with a subtitle file made elsewhere. */
export function TranscriptFileModal({ open, onOpenChange, projectId, hasTranscript, canImport, whyNot }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string; hasTranscript: boolean; canImport: boolean; whyNot: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState("");
  const [busy, setBusy] = useState(false);
  const imp = useMutation(trpc.projects.importTranscript.mutationOptions());
  const base = `/api/projects/${projectId}/transcript`;

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const uploadId = await uploadFile(file);
      const r = await imp.mutateAsync({ id: projectId, uploadId, language: language.trim() || undefined });
      void qc.invalidateQueries({ queryKey: trpc.projects.pathKey() });
      void qc.invalidateQueries({ queryKey: trpc.transcripts.pathKey() });
      toast.success(r.message, { description: r.warnings[0] });
      setFile(null);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message.slice(0, 200) : "Could not import that file");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={(o) => !busy && onOpenChange(o)} title="Transcript files" width={460}>
      <Dialog.Description className="text-sm leading-relaxed text-ink2">Download the transcript as subtitles, or use a subtitle file instead of transcribing.</Dialog.Description>
      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-semibold text-ink2">Download</div>
        <div className="flex gap-2">
          {(["srt", "vtt"] as const).map((f) =>
            hasTranscript ? (
              <a key={f} className="btn-ghost min-w-[88px] justify-center no-underline" href={`${base}.${f}`} download>
                {f.toUpperCase()}
              </a>
            ) : (
              <button key={f} className="btn-ghost min-w-[88px] justify-center" disabled title="Available once the project has a transcript">
                {f.toUpperCase()}
              </button>
            ),
          )}
          {hasTranscript && (
            <a className="btn-ghost justify-center no-underline" href={`${base}.vtt?words=1`} download title="WebVTT with a timestamp before every word">
              VTT with word times
            </a>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-semibold text-ink2">Import</div>
        <input
          ref={input}
          type="file"
          accept=".srt,.vtt,.txt,text/vtt,application/x-subrip"
          className="hidden"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
        <div className="flex items-center gap-2">
          <button className="btn-ghost shrink-0" disabled={!canImport || busy} title={canImport ? undefined : whyNot} onClick={() => input.current?.click()}>
            Choose .srt or .vtt…
          </button>
          <span className="min-w-0 flex-1 truncate text-sm text-ink2">{file ? file.name : "No file chosen"}</span>
        </div>
        <input className="input" value={language} onChange={(e) => setLanguage(e.target.value)} maxLength={12} placeholder="Language code (optional), e.g. en" aria-label="Language code" disabled={!canImport || busy} />
        <p className="min-h-[2.5rem] text-xs leading-relaxed text-ink3">{canImport ? "The file replaces the current transcript. The project then cleans it up and picks clips again; word timing inside each line is estimated and re-aligned when a clip renders." : whyNot}</p>
      </div>
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" disabled={busy} onClick={() => onOpenChange(false)}>
          Close
        </button>
        <button className="btn-primary min-w-[96px] justify-center" disabled={!file || !canImport || busy} onClick={() => void run()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Importing" /> : "Import"}
        </button>
      </div>
    </Modal>
  );
}
