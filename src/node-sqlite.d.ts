// node:sqlite (Node 22.5+, unflagged in the VS Code extension host's Node 24).
// @types/node 20 predates it; this declares only what src/ and test/ use.
declare module 'node:sqlite' {
  interface StatementSync {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
    readonly isTransaction: boolean;
  }
}
