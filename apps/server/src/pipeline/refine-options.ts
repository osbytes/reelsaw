/**
 * Effective refine-stage gates: instance (env → admin runtime override) is a ceiling; the project's
 * frozen settings can only turn steps further off. Precedence is documented in the README under
 * "Settings and precedence".
 */
import type { ProjectSettings } from "@reelsaw/shared";
import type { RefineStep } from "@reelsaw/shared";
import type { RuntimeSettings } from "../instance-settings.js";

export type RefineOptions = {
  entities: boolean;
  disfluency: boolean;
  /** Only meaningful when disfluency is on. */
  disfluencyLlm: boolean;
  scenes: boolean;
};

type InstanceRefine = Pick<RuntimeSettings, "TRANSCRIPT_CORRECTION" | "DISFLUENCY_REMOVAL" | "DISFLUENCY_LLM" | "REFINE_SCENES">;
type ProjectRefine = Partial<Pick<ProjectSettings, "refineEntities" | "refineDisfluency" | "disfluencyLlm" | "refineScenes">>;

/**
 * Instance off wins (ceiling). Name fixes and the on-screen text scan are on unless the project turns
 * them off; disfluency removal (and its model pass) is opt-in. A key missing on an older row takes
 * that built-in default.
 */
export function resolveRefineOptions(instance: InstanceRefine, project: ProjectRefine = {}): RefineOptions {
  const entities = !!instance.TRANSCRIPT_CORRECTION && (project.refineEntities ?? true) === true;
  const disfluency = !!instance.DISFLUENCY_REMOVAL && project.refineDisfluency === true;
  const disfluencyLlm = disfluency && !!instance.DISFLUENCY_LLM && project.disfluencyLlm === true;
  const scenes = !!instance.REFINE_SCENES && (project.refineScenes ?? true) === true;
  return { entities, disfluency, disfluencyLlm, scenes };
}

export function refineStepOn(opts: RefineOptions, step: RefineStep): boolean {
  if (step === "entities") return opts.entities;
  if (step === "disfluency") return opts.disfluency;
  return opts.scenes;
}
