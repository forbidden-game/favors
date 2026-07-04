import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, "../../..");
export const dataDir = process.env.FAVORS_DATA_DIR
  ? path.resolve(process.env.FAVORS_DATA_DIR)
  : path.join(repoRoot, "data");
export const itemDir = path.join(dataDir, "items");
export const assetDir = path.join(dataDir, "assets");
export const webDistDir = path.join(repoRoot, "apps/web/dist");

