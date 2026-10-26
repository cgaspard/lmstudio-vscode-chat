// Provider ids as the panel knows them vs. as the embedded engine knows them.
//
// OpenCode 2 ships built-in plugins for local servers under the ids `lmstudio`,
// `ollama` and `vllm`. Once one of them discovers models it takes over any
// provider with its id: it deletes every model declared there and replaces the
// provider's settings, so a provider the panel configured under that id would
// silently lose its reasoning variants, context limits and options. The
// one-click scan names servers "Ollama" and "vLLM", which slug to exactly those
// ids. So at the engine boundary those ids get a suffix, and come back without
// it; everything the user sees, stores and selects keeps the familiar id.

/** Ids claimed by OpenCode 2's built-in local provider plugins. */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set(['lmstudio', 'ollama', 'vllm']);

const SUFFIX = '-vscode-panel';

export function toEngineProviderID(id: string): string {
  return RESERVED_PROVIDER_IDS.has(id) ? id + SUFFIX : id;
}

export function fromEngineProviderID(id: string): string {
  if (id.endsWith(SUFFIX)) {
    const base = id.slice(0, -SUFFIX.length);
    if (RESERVED_PROVIDER_IDS.has(base)) {
      return base;
    }
  }
  return id;
}
