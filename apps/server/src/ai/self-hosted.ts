/** Local models are slow and sequential; cloud models take parallel calls and extra samples. */
export function isSelfHostedModel(cfg: { AI_MODEL: string; OPENAI_BASE_URL?: string }): boolean {
  const provider = cfg.AI_MODEL.split(":")[0];
  return provider === "compat" || provider === "ollama" || (provider === "openai" && !!cfg.OPENAI_BASE_URL);
}
