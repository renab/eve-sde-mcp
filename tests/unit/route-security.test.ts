import { describe, expect, it } from "vitest";
import { securityInfo, shortestHighsecRoute } from "../../src/route-security.js";

describe("EVE security classification", () => {
  it.each([
    [0.449999, 0.4, "lowsec"], [0.45, 0.5, "highsec"], [0.450001, 0.5, "highsec"],
    [0.949, 0.9, "highsec"], [0.00001, 0.1, "lowsec"], [0, 0, "nullsec"],
    [-0.01, 0, "nullsec"], [-0.8, -0.8, "nullsec"],
  ])("classifies raw %s", (raw, displaySecurity, securityClass) => {
    expect(securityInfo(raw as number)).toEqual({ displaySecurity, securityClass });
  });
  it("keeps missing security unknown", () => {
    expect(securityInfo(null)).toEqual({ displaySecurity: null, securityClass: null });
  });
});
describe("shortest highsec graph search", () => {
  const edges = [[1, 3], [3, 4], [4, 2], [1, 5], [5, 2], [3, 1]]
    .map(([fromSolarSystemID, toSolarSystemID]) => ({ fromSolarSystemID, toSolarSystemID }));
  it("minimizes jumps even when the longer path is visited first", () => {
    expect(shortestHighsecRoute(1, 2, edges, [])).toEqual([1, 5, 2]);
  });
  it("respects avoidance and cycles", () => {
    expect(shortestHighsecRoute(1, 2, edges, [5])).toEqual([1, 3, 4, 2]);
  });
  it("fails rather than falling back when disconnected", () => {
    expect(() => shortestHighsecRoute(1, 2, edges, [3, 5])).toThrow("No highsec-only");
  });
  it("rejects avoided endpoints", () => {
    expect(() => shortestHighsecRoute(1, 2, edges, [2])).toThrow("avoided origin or destination");
  });
  it("handles identical endpoints", () => {
    expect(shortestHighsecRoute(1, 1, [], [])).toEqual([1]);
  });
});
