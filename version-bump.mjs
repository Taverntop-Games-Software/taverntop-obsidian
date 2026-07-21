// Keeps manifest.json + versions.json in lockstep with package.json's version.
// Wired to `npm version` via the "version" script in package.json, so:
//   npm version patch   →   bumps package.json, runs this, stages manifest+versions
// then `git push --follow-tags` fires the release workflow.
import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error("version-bump: npm_package_version not set — run via `npm version`.");
  process.exit(1);
}

// manifest.json: set version, keep minAppVersion as the compatibility floor.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

// versions.json: record which minAppVersion this plugin version needs, so
// Obsidian can offer the newest compatible build to older app installs.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`version-bump: manifest + versions set to ${targetVersion} (minAppVersion ${minAppVersion}).`);
