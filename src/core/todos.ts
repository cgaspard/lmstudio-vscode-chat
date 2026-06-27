// Pure logic for the agent's todo checklist (the todowrite tool). Kept DOM-free
// so the progress math + collapse/label decisions can be unit-tested.

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Todo {
  content: string;
  status: TodoStatus;
  priority?: string;
  id?: string;
}

export interface TodoSummary {
  done: number; // completed count
  total: number; // todos excluding cancelled (so progress reads sensibly)
  anyInProgress: boolean;
  allDone: boolean; // every non-cancelled item completed, nothing in progress
  cardStatus: 'pending' | 'running' | 'completed';
  /** Collapsed-header summary line, e.g. "● <current>", "Next: <pending>", "✓ Done". */
  currentLabel: string;
}

export function summarizeTodos(todos: Todo[]): TodoSummary {
  const done = todos.filter((t) => t.status === 'completed').length;
  const total = todos.filter((t) => t.status !== 'cancelled').length; // cancelled out of both
  const anyInProgress = todos.some((t) => t.status === 'in_progress');
  const allDone = total > 0 && done === total && !anyInProgress;
  const cardStatus = anyInProgress ? 'running' : allDone ? 'completed' : 'pending';
  const current = todos.find((t) => t.status === 'in_progress');
  const nextPending = todos.find((t) => t.status === 'pending');
  const currentLabel = current
    ? '● ' + current.content
    : allDone
      ? '✓ Done'
      : nextPending
        ? 'Next: ' + nextPending.content
        : '';
  return { done, total, anyInProgress, allDone, cardStatus, currentLabel };
}

/**
 * Whether the checklist card should be collapsed. Expanded by default (the plan
 * is worth seeing), so it only collapses when the user manually toggles it.
 * `anyInProgress` is accepted for call-site symmetry but no longer changes the
 * default — the list stays open unless the user closes it.
 */
export function isTodoCardCollapsed(_anyInProgress: boolean, forced: boolean | undefined): boolean {
  return forced ?? false;
}
