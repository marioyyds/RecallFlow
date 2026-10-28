// 统计「导出面含 any」：导出声明（函数参数/返回、const 标注、type、interface、class）里
// 任意位置出现 `any` 就算 1 条（同一声明只计一次）。
//
// 为什么要有这条脚本：Batch 6a 的评审只能用一次性脚本复算出 238→202，别人无法复核门槛；
// Batch 6b 把口径固化成命令，门槛才可被独立验算（L-18：每个数字附产生它的命令）。
//
// 用法：
//   node scripts/count-any-surface.mjs            # 统计当前工作树
//   node scripts/count-any-surface.mjs --verbose  # 逐条列 文件:行 声明名
//   node scripts/count-any-surface.mjs --json     # 机器可读
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'site', 'integrations', 'repro']);
// 统计范围：仓库内所有 .ts 源码（当前 = lib/** + entries/**）。产物是同名 .js，不在内。
const INCLUDE_DIRS = ['lib', 'entries'];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
}

/** 类型节点里是否出现 `any`（含泛型实参、联合/交叉、索引、函数类型、类型字面量成员）。 */
function typeHasAny(node) {
  if (!node) return false;
  let hit = false;
  const visit = (n) => {
    if (hit || !n) return;
    if (n.kind === ts.SyntaxKind.AnyKeyword) {
      hit = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

function signatureHasAny(fn) {
  if (fn.typeParameters) {
    for (const tp of fn.typeParameters) {
      if (typeHasAny(tp.constraint) || typeHasAny(tp.default)) return true;
    }
  }
  for (const p of fn.parameters) if (typeHasAny(p.type)) return true;
  return typeHasAny(fn.type);
}

function isExported(node) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(mods && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

const files = [];
for (const d of INCLUDE_DIRS) {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) walk(abs, files);
}

const rows = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  for (const stmt of src.statements) {
    let name = '';
    let bad = false;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      if (!isExported(stmt)) continue;
      name = stmt.name.text;
      bad = signatureHasAny(stmt);
    } else if (ts.isVariableStatement(stmt)) {
      if (!isExported(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        const n = decl.name && ts.isIdentifier(decl.name) ? decl.name.text : '(destructure)';
        const hit =
          typeHasAny(decl.type) ||
          (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
            ? signatureHasAny(decl.initializer)
            : false);
        if (hit) {
          rows.push({ file: rel, line: src.getLineAndCharacterOfPosition(decl.getStart(src)).line + 1, name: n });
          bad = false;
        }
      }
      continue;
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      if (!isExported(stmt)) continue;
      name = stmt.name.text;
      bad = typeHasAny(stmt.type);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      if (!isExported(stmt)) continue;
      name = stmt.name.text;
      bad = stmt.members.some((m) => {
        let hit = false;
        ts.forEachChild(m, (c) => {
          if (!hit && ts.isTypeNode(c) && typeHasAny(c)) hit = true;
        });
        if (hit) return true;
        // 方法签名：参数与返回分别遍历
        if (ts.isMethodSignature(m)) return signatureHasAny(m);
        if (ts.isPropertySignature(m)) return typeHasAny(m.type);
        if (ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m)) return signatureHasAny(m);
        return false;
      });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      if (!isExported(stmt)) continue;
      name = stmt.name.text;
      bad = stmt.members.some((m) => {
        if (ts.isMethodDeclaration(m) && signatureHasAny(m)) return true;
        if (ts.isPropertyDeclaration(m) && typeHasAny(m.type)) return true;
        if (ts.isConstructorDeclaration(m) && signatureHasAny(m)) return true;
        if (ts.isGetAccessor(m) || ts.isSetAccessor(m)) return signatureHasAny(m);
        return false;
      });
    } else {
      continue;
    }
    if (bad) rows.push({ file: rel, line: src.getLineAndCharacterOfPosition(stmt.getStart(src)).line + 1, name });
  }
}

rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: rows.length, declarations: rows }, null, 2));
} else {
  if (process.argv.includes('--verbose')) {
    for (const r of rows) console.log(r.file + ':' + r.line + '  ' + r.name);
  }
  const byFile = new Map();
  for (const r of rows) byFile.set(r.file, (byFile.get(r.file) || 0) + 1);
  for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4) + '  ' + f);
  console.log('\n导出面含 any 的声明数：' + rows.length + '（' + files.length + ' 个 .ts 文件）');
}
