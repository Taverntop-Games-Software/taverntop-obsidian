// Minimal stand-in for the `obsidian` module so the pure sync logic (mapper + mock
// client) can run headlessly in Node. Only the symbols the modules-under-test import
// are provided. The full Obsidian API is only needed for SyncEngine's vault I/O, which
// is exercised inside Obsidian itself, not here.
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}
