import { DEFAULT_EMAIL_PREFERENCES, EMAIL_TOPIC_NAMES, EMAIL_TOPICS, type EmailTopic } from "@reelsaw/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useMe } from "../lib/account";
import { useTRPC } from "../lib/trpc";

/**
 * Settings → Account → Email: optional mail by topic (apps/server/src/notify/preferences.ts). Shown only when
 * this instance sends mail. `/settings#email` is the link in the ready email's footer; Settings lands on it.
 */
export function EmailSection() {
  const me = useMe();
  const qc = useQueryClient();
  const trpc = useTRPC();
  const setPrefs = useMutation(
    trpc.me.updateEmailPreferences.mutationOptions({
      onSuccess: (r, patch) => {
        const topic = EMAIL_TOPIC_NAMES.find((t) => patch[t] !== undefined);
        if (topic) toast(r.emailPreferences[topic] ? "Email turned on" : "Email turned off");
        void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const pending = setPrefs.isPending ? setPrefs.variables : undefined;
  const wants = (t: EmailTopic) => pending?.[t] ?? me.data?.emailPreferences[t] ?? DEFAULT_EMAIL_PREFERENCES[t];

  return (
    <section id="email" className="flex scroll-mt-4 flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <h2 className="text-[15px] font-bold">Email</h2>
      {EMAIL_TOPIC_NAMES.map((topic) => (
        <label key={topic} className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-1 accent-[var(--acc)]"
            checked={wants(topic)}
            disabled={setPrefs.isPending}
            onChange={(e) => setPrefs.mutate({ [topic]: e.target.checked })}
          />
          <span>
            <b className="font-semibold">{EMAIL_TOPICS[topic].label}</b>
            <br />
            <span className="text-[13px] font-normal text-ink2">{EMAIL_TOPICS[topic].description}</span>
          </span>
        </label>
      ))}
      <span className="text-[13px] text-ink2">Password resets and other mail you need always come.</span>
    </section>
  );
}
