/** Model picker filter (AC-FN-18): case-insensitive substring match. */
export function matchesModelFilter(name: string | undefined, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (!name) return false;
    return name.toLowerCase().includes(q);
}
