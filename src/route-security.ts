// https://developers.eveonline.com/docs/guides/system-security/
export function securityInfo(raw: number | null) {
  if (raw === null || !Number.isFinite(raw)) return { displaySecurity: null, securityClass: null };
  return {
    displaySecurity: raw > 0 ? Math.max(0.1, Math.round(raw * 10) / 10) : Math.round(raw * 10) / 10 || 0,
    securityClass: raw >= 0.45 ? "highsec" : raw > 0 ? "lowsec" : "nullsec",
  };
}

/** Breadth-first search minimizes gate count; edges must already be highsec-only. */
export function shortestHighsecRoute(
  origin: number, destination: number,
  edges: { fromSolarSystemID: number; toSolarSystemID: number }[], avoided: number[]
): number[] {
  const blocked = new Set(avoided);
  if (blocked.has(origin) || blocked.has(destination)) throw new Error("A highsec-only route cannot include an avoided origin or destination.");
  const graph = new Map<number, number[]>();
  for (const edge of edges) {
    if (blocked.has(edge.fromSolarSystemID) || blocked.has(edge.toSolarSystemID)) continue;
    const neighbors = graph.get(edge.fromSolarSystemID) ?? [];
    neighbors.push(edge.toSolarSystemID);
    graph.set(edge.fromSolarSystemID, neighbors);
  }
  const parents = new Map<number, number | null>([[origin, null]]);
  const queue = [origin];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current === destination) {
      const route: number[] = [];
      for (let id: number | null = destination; id !== null; id = parents.get(id)!) route.push(id);
      return route.reverse();
    }
    for (const neighbor of graph.get(current) ?? []) {
      if (parents.has(neighbor)) continue;
      parents.set(neighbor, current);
      queue.push(neighbor);
    }
  }
  throw new Error("No highsec-only stargate route exists in the installed SDE with these avoided systems. No lowsec fallback was used.");
}
