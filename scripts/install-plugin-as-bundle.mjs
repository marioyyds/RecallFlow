#!/usr/bin/env node
/**
 * 把 RecallFlow 插件从「本地文件 insert」改成「可被 DSH 插件管理器管理的包」。
 *
 * ## 默认是 dry-run
 *
 *     node scripts/install-plugin-as-bundle.mjs            # 只打印计划，什么都不改
 *     node scripts/install-plugin-as-bundle.mjs --apply    # 真的改（会先备份）
 *     node scripts/install-plugin-as-bundle.mjs --rollback # 从最近的备份恢复
 *
 * 这个脚本会改**用户正在使用的 profile**，所以默认不动手：先把每一步打出来，
 * 让人看清"要改哪两个文件、改成什么、怎么回退"，再决定要不要 --apply。
 * 目标里那句"不得破坏用户正在使用的 DSH"就是这个意思。
 *
 * ## 为什么必须 `link:` 安装
 *
 * 插件有 3 个 import 指向包外（仓库里的共享模块，刻意共用一份实现、不复制）：
 *
 *     ../../lib/shared/tool-results.js  ../../lib/shared/dev-session.js  ../../lib/shared/evidence-store.js
 *
 * 按 profile 布局（`<profile>/node_modules/<name>`）实测过：
 *   拷贝式 → ✗ Cannot find module '…\copy-profile\lib\shared\tool-results.js'
 *   链接式 → ✓ import 成功
 * 因为 Node 默认跟随符号链接、按**真实路径**解析模块，`../../` 才回到仓库里。
 *
 * ## 为什么要"原子替换"
 *
 * 这条 insert 与 bundles 里的包名**不能同时存在** —— 插件会被加载两次，
 * `/recallflow/*` 的路由会冲突。所以删 insert 与加 bundle 必须在**同一次改动**里完成，
 * 而且先备份，出问题就 `--rollback` + 重启 DSH。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = path.join(ROOT, 'integrations', 'dsh-plugin-recallflow-one');
const PKG_NAME = 'recallflow-dsh-plugin';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const rollback = args.includes('--rollback');

/** profile 目录：默认 web，可用 PROFILE=xxx 覆盖。 */
const profileName = process.env.PROFILE || 'web';
const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', profileName);
const PATCH = path.join(PROFILE, 'cordis.patch.yml');
const PROFILE_PKG = path.join(PROFILE, 'package.json');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function say(step, text) {
  console.log('  ' + step + ' ' + text);
}

function readPatch() {
  return readFileSync(PATCH, 'utf8');
}

/** 找到那条指向插件的 file-path insert（我们要删掉它）。 */
function findPluginInsert(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/dsh-plugin-recallflow-one[\\/]index\.js/.test(lines[i])) out.push(i);
  }
  return out;
}

function plan() {
  console.log('--- 计划：把插件改成包（profile=' + profileName + '）---');
  say('1)', '确认包文件齐备：' + PKG_DIR);
  for (const f of ['package.json', 'cordis.patch.yml', 'index.js']) {
    say('   ', (existsSync(path.join(PKG_DIR, f)) ? '✓ ' : '✗ 缺少 ') + f);
  }
  say('2)', '备份（带时间戳，不覆盖旧备份）：');
  say('   ', PATCH + ' → cordis.patch.yml.bak-' + stamp());
  say('   ', PROFILE_PKG + ' → package.json.bak-' + stamp());
  say('3)', '用 link: 安装（拷贝式会坏，见脚本头注释）：');
  say('   ', 'cd ' + PROFILE + ' && pnpm add link:' + PKG_DIR);
  say('4)', 'profile/package.json 的 dsh.profile.bundles 加上 "' + PKG_NAME + '"');
  say('5)', 'profile/cordis.patch.yml 里**删掉**指向 ' + PKG_DIR + '\\index.js 的那条 insert');
  say('   ', '（必须与第 4 步同一次完成：同时存在会加载两次，/recallflow/* 路由冲突）');
  say('6)', '重启 DSH，然后跑：node scripts/verify-capability-tiers.mjs');
  say('回滚', 'node scripts/install-plugin-as-bundle.mjs --rollback  然后重启 DSH');
  console.log('');
  const patch = readPatch();
  const hits = findPluginInsert(patch);
  console.log('  当前 cordis.patch.yml 里指向该插件的行：' + (hits.length ? hits.map((i) => i + 1).join('、') : '（没找到 —— 可能已经换成包了）'));
  if (!hits.length) {
    console.log('      → 若 bundles 里已经有 ' + PKG_NAME + '，说明已经切换完成。');
  }
  console.log('');
  console.log(apply ? '  （--apply：下面真的执行）' : '  （dry-run：什么都没改。要执行请加 --apply）');
}

function backup(file) {
  const bak = file + '.bak-' + stamp();
  copyFileSync(file, bak);
  say('备份', path.basename(bak));
  return bak;
}

function doApply() {
  if (!existsSync(PATCH) || !existsSync(PROFILE_PKG)) {
    console.log('  ✗ 找不到 profile 文件：' + PATCH);
    process.exit(2);
  }
  console.log('--- 执行（--apply）---');
  backup(PATCH);
  backup(PROFILE_PKG);

  // 3) 安装
  say('安装', 'pnpm add link:' + PKG_DIR);
  try {
    execFileSync('pnpm', ['add', 'link:' + PKG_DIR], { cwd: PROFILE, stdio: 'inherit', shell: true });
  } catch (e) {
    console.log('  ✗ pnpm add 失败：' + (e && e.message) + '（其余改动未做）');
    process.exit(3);
  }

  // 4) bundles
  const pkg = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'));
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
  if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) {
    pkg.dsh.profile.bundles.push(PKG_NAME);
    writeFileSync(PROFILE_PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    say('bundles', '已加入 ' + PKG_NAME);
  } else {
    say('bundles', '已存在 ' + PKG_NAME + '，跳过');
  }

  // 5) 删掉那条 file-path insert（整块：从 "- insert:" 到下一个顶层 "- " 之前）
  const lines = readPatch().split(/\r?\n/);
  const hit = lines.findIndex((l) => /dsh-plugin-recallflow-one[\\/]index\.js/.test(l));
  if (hit < 0) {
    say('patch', '没找到那条 insert，跳过（可能已切换）');
  } else {
    let start = hit;
    while (start > 0 && !/^\s*-\s*insert:/.test(lines[start])) start--;
    let end = hit;
    while (end + 1 < lines.length && !/^\s*-\s*(insert:|include:)/.test(lines[end + 1])) end++;
    const removed = lines.splice(start, end - start + 1);
    writeFileSync(PATCH, lines.join('\n'), 'utf8');
    say('patch', '已删除 ' + removed.length + ' 行（第 ' + (start + 1) + '–' + (end + 1) + ' 行）');
  }

  console.log('');
  say('下一步', '重启 DSH，然后：node scripts/verify-capability-tiers.mjs');
  say('回滚', 'node scripts/install-plugin-as-bundle.mjs --rollback  然后重启 DSH');
}

function doRollback() {
  console.log('--- 回滚：从最近的备份恢复 ---');
  for (const f of [PATCH, PROFILE_PKG]) {
    const dir = path.dirname(f);
    const base = path.basename(f) + '.bak-';
    const baks = readdirSync(dir)
      .filter((n) => n.startsWith(base))
      .sort();
    if (!baks.length) {
      say('回滚', '✗ 没找到 ' + base + '* 的备份');
      continue;
    }
    const latest = path.join(dir, baks[baks.length - 1]);
    copyFileSync(latest, f);
    say('回滚', path.basename(f) + ' ← ' + baks[baks.length - 1]);
  }
  console.log('');
  say('注意', '如果已经 pnpm add 过，还可能要 pnpm remove ' + PKG_NAME + '（或留在 node_modules 也无害）。');
  say('下一步', '重启 DSH。');
}

if (rollback) doRollback();
else if (apply) doApply();
else plan();
