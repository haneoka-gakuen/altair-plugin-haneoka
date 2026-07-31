import { access, readFile, readdir } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
for (const path of [
  "dist/index.js",
  "dist/index.d.ts",
  "LICENSE",
  "README.md",
  "SECURITY.md",
]) {
  await access(new URL(`../${path}`, import.meta.url));
}
if (manifest.name !== "@haneoka/altair-plugin-haneoka") {
  throw new Error("Unexpected package name");
}
if (manifest.altair?.pluginApi !== 2 || manifest.altair?.kind !== "service") {
  throw new Error("Altair plugin metadata is incomplete");
}
const distFiles = await readdir(new URL("../dist/", import.meta.url));
const distSource = (
  await Promise.all(
    distFiles
      .filter((file) => /\.(?:js|d\.ts)$/u.test(file))
      .map((file) =>
        readFile(new URL(`../dist/${file}`, import.meta.url), "utf8"),
      ),
  )
).join("\n");
for (const forbidden of [
  "@haneoka/bestdori",
  "packages/story",
  "packages/story-editor",
  "Live2DCubismCore",
]) {
  if (distSource.includes(forbidden)) {
    throw new Error(
      `Published output contains forbidden host/runtime coupling: ${forbidden}`,
    );
  }
}
console.log(`Verified ${manifest.name}@${manifest.version}`);
