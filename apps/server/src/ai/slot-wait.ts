/**
 * Time a model call spends queued for a provider slot (ai/gate.ts) is not time the model spent on it. A pipeline step
 * (pipeline/steps.ts) runs its work under a listener; the gate tells it when a call starts and stops waiting, and the
 * step's time limit stops counting meanwhile. Without this, a job queued behind other jobs' calls on one local model
 * server timed out for the queue it stood in, and its retry joined the same queue.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface SlotWaitListener {
  /** a call started waiting for a slot */
  waiting(): void;
  /** that call got its slot, or gave up waiting (aborted) */
  acquired(): void;
}

const store = new AsyncLocalStorage<SlotWaitListener>();

/** Run `fn` with `listener` told about every provider-slot wait made inside it. */
export const withSlotWaitListener = <T>(listener: SlotWaitListener, fn: () => T): T => store.run(listener, fn);

/** The listener of the step this call belongs to, if any. */
export const slotWaitListener = (): SlotWaitListener | undefined => store.getStore();
