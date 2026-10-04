// Writes the committed Relayer mark assets from the renderer's mark geometry so the app
// icon, favicon, share attribution image and the in-app tile mask cannot drift from it.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { markSvg } from "../desktop/renderer/src/relayer-mark.js";
import { resolveDesignPath } from "./design/build.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const assetsDirectory = resolve(repositoryRoot, "desktop/renderer/assets");

// The icon is the light-appearance tile: ink on the design's light text colour, slashes in its
// light background. The mask is white tile, black slashes, applied in luminance mode so the
// in-app tiles take the current theme's text colour and show the page through the slashes.
export async function relayerLogoAssets() {
  // Always the committed default design: a lab design selected through RELAYER_DESIGN restyles
  // the running app, but the icon, favicon and share image are built once from the default.
  const design = JSON.parse(await readFile(await resolveDesignPath(""), "utf8"));
  const { text, bg } = design.palette.roles;
  return {
    "relayer-logo.svg": markSvg({ tile: text.light, ink: bg.light }),
    "relayer-mark-mask.svg": markSvg({ tile: "#fff", ink: "#000" }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, svg] of Object.entries(await relayerLogoAssets())) {
    await writeFile(resolve(assetsDirectory, name), svg);
    console.log(`wrote desktop/renderer/assets/${name} (${svg.length} bytes)`);
  }
}
