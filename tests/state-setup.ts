import { beforeEach } from "vitest";
import { closeStateDatabase } from "../src/persistence.js";
beforeEach(() => closeStateDatabase());
