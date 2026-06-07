/**
 * Model-selection logic, extracted so reconnect/init paths pick a sensible
 * model deterministically and it can be unit-tested without vscode.
 */

export interface SelectableModel {
  id: string;
  loaded?: boolean;
}

/**
 * Pick the model to use: the first preference that exists, else a currently
 * loaded model, else the first available. Returns undefined when there are no
 * models. Empty / null preferences are skipped so callers can pass
 * `[defaultModel, stored, current]` without pre-filtering.
 */
export function pickModel<T extends SelectableModel>(
  preferences: Array<string | null | undefined>,
  models: T[],
): string | undefined {
  for (const pref of preferences) {
    if (pref && models.some((m) => m.id === pref)) {
      return pref;
    }
  }
  const loaded = models.find((m) => m.loaded);
  return loaded?.id ?? models[0]?.id;
}
