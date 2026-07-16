export function newId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for very old environments
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
