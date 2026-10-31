import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeEditableText,
  editableTextMatches,
  firstEditableDifference,
  editableTextSummary,
  readContentEditableText,
} from '../lib/shared/editable-text.ts';

const textNode = (value) => ({ nodeType: 3, nodeValue: value, childNodes: [] });
const element = (name, children = []) => ({
  nodeType: 1,
  nodeName: name,
  tagName: name,
  childNodes: children,
});

test('normalizeEditableText：统一换行、NBSP 与尾随空行', () => {
  assert.equal(normalizeEditableText('a\r\nb\rc\u00a0d\n\n'), 'a\nb\nc d');
});

test('editableTextMatches：保留正文内部空白与换行，只忽略编辑器尾随换行', () => {
  assert.equal(editableTextMatches('a\nb', 'a\nb\n'), true);
  assert.equal(editableTextMatches('a\nb', 'a b'), false);
  assert.equal(editableTextMatches('a  b', 'a b'), false);
});

test('firstEditableDifference：指出首个差异并给出上下文', () => {
  const d = firstEditableDifference('第一行\n第二行', '第一行\n第三行');
  assert.equal(d.index, 5);
  assert.match(d.expected, /第二行/);
  assert.match(d.actual, /第三行/);
  assert.equal(firstEditableDifference('same', 'same').index, -1);
});

test('editableTextSummary：长度按归一化后的文本计算', () => {
  const s = editableTextSummary('a\r\nb\n', 'a\nb');
  assert.equal(s.matchesIntent, true);
  assert.equal(s.expectedLength, 3);
  assert.equal(s.actualLength, 3);
});

test('readContentEditableText：块级段落只贡献一个逻辑换行', () => {
  const root = element('DIV', [
    element('P', [textNode('第一行')]),
    element('P', [textNode('第二行')]),
  ]);
  assert.equal(readContentEditableText(root), '第一行\n第二行');
});

test('readContentEditableText：空段落保留为一个真实空行，占位 br 不重复计数', () => {
  const root = element('DIV', [
    element('P', [textNode('A')]),
    element('P', [element('BR')]),
    element('P', [textNode('B')]),
  ]);
  assert.equal(readContentEditableText(root), 'A\n\nB');
});

test('readContentEditableText：段内 br 保留换行，结尾编辑器占位换行不计入内容', () => {
  const root = element('DIV', [
    element('P', [textNode('A'), element('BR'), textNode('B')]),
    element('P', [element('BR')]),
  ]);
  assert.equal(readContentEditableText(root), 'A\nB');
});
