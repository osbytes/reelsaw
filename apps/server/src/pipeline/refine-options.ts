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
 * Instance off wins (ceiling). Project fields are opt-in (`=== true`); missing keys on older rows
 * count as off so upgrades stay on the fast/cheap path until someone turns a step on.
 */
export function resolveRefineOptions(instance: InstanceRefine, project: ProjectRefine = {}): RefineOptions {
  const entities = !!instance.TRANSCRIPT_CORRECTION && project.refineEntities === true;
  const disfluency = !!instance.DISFLUENCY_REMOVAL && project.refineDisfluency === true;
  const disfluencyLlm = disfluency && !!instance.DISFLUENCY_LLM && project.disfluencyLlm === true;
  const scenes = !!instance.REFINE_SCENES && project.refineScenes === true;
  return { entities, disfluency, disfluencyLlm, scenes };
}

export function refineStepOn(opts: RefineOptions, step: RefineStep): boolean {
  if (step === "entities") return opts.entities;
  if (step === "disfluency") return opts.disfluency;
  return opts.scenes;
}
