/**
 * Model ids as the pipeline, the picker and the settings use them: "<provider>:<model>", where the model part may
 * hold colons of its own (an Ollama tag, "compat:qwen2.5:14b"). Server and web read them through these two only.
 */

/** "openai" from "openai:gpt-4o-mini". */
export function providerOf(id: string): string {
  return id.split(":", 1)[0] ?? "";
}

/** "gpt-4o-mini" from "openai:gpt-4o-mini"; "qwen2.5:14b" from "compat:qwen2.5:14b". */
export function modelOf(id: string): string {
  return id.slice(providerOf(id).length + 1);
}
