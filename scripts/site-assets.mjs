import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = path.join("docs", "assets");
const TARGET_DIR = path.join("site", "assets");

function listFiles(directory, prefix, collected) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      listFiles(absolute, relative, collected);
    } else if (entry.isFile()) {
      collected.push(relative);
    }
  }
  return collected;
}

export function prepareSiteAssets(repoRoot) {
  const root = path.resolve(repoRoot);
  const source = path.join(root, SOURCE_DIR);
  const target = path.join(root, TARGET_DIR);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`找不到素材目录 docs/assets（repoRoot=${root}）`);
  }
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
  const files = listFiles(target, "", []).map((relative) => `assets/${relative}`);
  return { copied: files.length, files };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { copied, files } = prepareSiteAssets(repoRoot);
  console.log(`已复制 ${copied} 个文件: docs/assets -> site/assets`);
  for (const file of files) {
    console.log(`  ${file}`);
  }
  process.exitCode = 0;
}
