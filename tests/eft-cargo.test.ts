import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
vi.mock("../src/auth/esi-client.js", () => ({ esiGetAll: vi.fn(), esiPost: vi.fn(), esiDelete: vi.fn(), getActiveCharacter: vi.fn() }));
import { esiGetAll, esiPost, getActiveCharacter } from "../src/auth/esi-client.js";
import { getDatabase, closeDatabase } from "../src/database.js";
import { parseEftFormat, registerFittingTools } from "../src/tools/fittings.js";

afterAll(() => closeDatabase());
const cargo = "Scourge Heavy Missile x1200\nNavy Cap Booster 400 x12\nNanite Repair Paste x80\nMobile Tractor Unit x1";
const examples = [
  `[Caracal, Cervantes C1 Generalist Caracal]\nDamage Control II\n\n10MN Afterburner II\n\nHeavy Missile Launcher II\n\nMedium Core Defense Field Extender I\n\nHobgoblin II x2\n\n${cargo}`,
  `[Confessor, Cervantes C1 Beam Test Confessor]\nDamage Control II\n\n1MN Afterburner II\n\nSmall Focused Beam Laser II\n\nSmall Energy Locus Coordinator I\n\n${cargo}`,
];
const typeId = (name: string) => (getDatabase().prepare("SELECT typeID FROM invTypes WHERE typeName = ? AND published = 1").get(name) as {typeID: number}).typeID;
const unpack = (result: any) => JSON.parse(result.content[0].text);

describe("operational EFT cargo", () => {
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  beforeEach(() => {
    vi.resetAllMocks();
    registerFittingTools({ tool: (name: string, _description: string, _schema: unknown, handler: any) => { handlers[name] = handler; } } as unknown as McpServer);
    vi.mocked(getActiveCharacter).mockResolvedValue({ characterId: 42, characterName: "Pilot" } as any);
  });
  it.each(examples)("preserves all cargo in %s", async eft => {
    const result = unpack(await handlers.parse_eft({ eft }));
    expect(result.valid).toBe(true);
    for (const [name, quantity] of [["Scourge Heavy Missile", 1200], ["Navy Cap Booster 400", 12], ["Nanite Repair Paste", 80], ["Mobile Tractor Unit", 1]] as const) {
      expect(result.items).toContainEqual(expect.objectContaining({ typeId: typeId(name), flag: "Cargo", quantity }));
    }
    for (const flag of ["LoSlot0", "MedSlot0", "HiSlot0", "RigSlot0"]) expect(result.items.some((i: any) => i.flag === flag)).toBe(true);
    if (eft.includes("Caracal")) expect(result.items).toContainEqual(expect.objectContaining({ flag: "DroneBay", quantity: 2 }));
  });
  it("accepts an MTU as the first cargo item with CRLF separators", () => {
    const result = parseEftFormat(getDatabase(), "[Caracal, Cargo]\r\nDamage Control II\r\n\r\nMobile Tractor Unit x1");
    expect(result.errors).toEqual([]);
    expect(result.items).toContainEqual({ type_id: typeId("Mobile Tractor Unit"), quantity: 1, flag: "Cargo" });
  });
  it("does not convert unknown cargo into a valid item", async () => {
    const result = unpack(await handlers.parse_eft({ eft: examples[0] + "\nFakeCargoXYZ123 x2" }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain('Item "FakeCargoXYZ123" not found in SDE');
  });
  it("warns explicitly about ambiguous placement in both preview and partial save", async () => {
    const eft = "[Caracal, Ambiguous]\nMobile Tractor Unit x1\nDamage Control II";
    const preview = unpack(await handlers.parse_eft({ eft }));
    expect(preview.valid).toBe(false);
    expect(preview.warnings.join(" ")).toContain("ambiguous");
    vi.mocked(esiPost).mockResolvedValue({ fitting_id: 123 });
    const saved = unpack(await handlers.save_fitting({ eft, description: "" }));
    expect(saved.warnings.join(" ")).toContain("Mobile Tractor Unit");
  });
  it.each(examples)("preserves cargo through mocked ESI save/read round trip: %s", async eft => {
    let stored: any;
    vi.mocked(esiPost).mockImplementation(async (_path, body) => { stored = { ...(body as object), fitting_id: 123 }; return { fitting_id: 123 } as any; });
    vi.mocked(esiGetAll).mockImplementation(async () => [stored]);
    const preview = unpack(await handlers.parse_eft({ eft }));
    const saved = unpack(await handlers.save_fitting({ eft, description: "" }));
    expect(saved.success).toBe(true);
    expect(stored.items).toEqual(preview.items.map((i: any) => ({ type_id: i.typeId, flag: i.flag, quantity: i.quantity })));
    const read = unpack(await handlers.get_fittings({}));
    expect(read.fittings[0].items).toContainEqual(expect.objectContaining({ typeId: typeId("Mobile Tractor Unit"), flag: "Cargo", quantity: 1 }));
  });
});
