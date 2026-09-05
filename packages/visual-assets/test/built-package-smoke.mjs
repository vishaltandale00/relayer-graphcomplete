import assert from "node:assert/strict";
import {
  createMemoryVisualAssetsLibrary,
  memoryHarnessFile,
} from "../dist/index.js";

const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><path d=\"M0 0h1v1H0z\"/></svg>";
const visualAssets = createMemoryVisualAssetsLibrary();
const asset = await visualAssets.add({
  file: memoryHarnessFile("built.svg", "image/svg+xml", svg),
  scope: { kind: "library" },
  name: "Built SVG",
  tagIds: [],
});
const inspection = await visualAssets.inspect(asset.id);
assert.equal(new TextDecoder().decode(await inspection.preview.read()), svg);

const rasterFixtures = [
  ["built.png", "image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="],
  ["built.jpg", "image/jpeg", "/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCPgDFmv//Z"],
];
for (const [name, mediaType, base64] of rasterFixtures) {
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  const raster = await visualAssets.add({
    file: memoryHarnessFile(name, mediaType, bytes),
    scope: { kind: "library" },
    name,
    tagIds: [],
  });
  assert.deepEqual(await (await visualAssets.inspect(raster.id)).preview.read(), bytes);
}

console.log("visual-assets built-package SVG/raster smoke passed");
