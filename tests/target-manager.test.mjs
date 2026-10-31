// 下载事件去重与任务识别。
//
// Chrome 可能同时上报 Page/Browser 两套 downloadWillBegin，随后再以 progress 更新状态。
// 如果按事件直接 push，诊断会出现重复文件；进度事件如果没有 guid 匹配，也不该制造幽灵项。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeDownloadEvent,
  shouldObserveDownloads,
} from '../lib/application/agent/target-manager.ts';

test('Page / Browser 同名下载按 guid 去重', () => {
  const first = mergeDownloadEvent([], 'Page.downloadWillBegin', {
    guid: 'g1',
    url: 'https://a.test/report.csv',
    suggestedFilename: 'report.csv',
  }, 100);
  const second = mergeDownloadEvent(first, 'Browser.downloadWillBegin', {
    guid: 'g1',
    url: 'https://a.test/report.csv',
    suggestedFilename: 'report.csv',
  }, 110);
  assert.equal(second.length, 1);
  assert.equal(second[0].at, 100, '开始时间保持第一次事件');
  assert.equal(second[0].updatedAt, 110);
});

test('progress 更新状态与字节数，且没有 begin 时不创建幽灵下载', () => {
  const started = mergeDownloadEvent([], 'Page.downloadWillBegin', {
    guid: 'g2',
    url: 'https://a.test/a.zip',
    suggestedFilename: 'a.zip',
  });
  const done = mergeDownloadEvent(started, 'Browser.downloadProgress', {
    guid: 'g2',
    state: 'completed',
    receivedBytes: 42,
    totalBytes: 42,
  });
  assert.equal(done.length, 1);
  assert.equal(done[0].state, 'completed');
  assert.equal(done[0].receivedBytes, 42);

  const orphan = mergeDownloadEvent([], 'Page.downloadProgress', {
    guid: 'missing',
    state: 'completed',
  });
  assert.deepEqual(orphan, []);
});

test('无 guid 时按 URL + 文件名去重', () => {
  const first = mergeDownloadEvent([], 'Page.downloadWillBegin', {
    url: 'https://a.test/file',
    suggestedFilename: 'file.pdf',
  });
  const second = mergeDownloadEvent(first, 'Browser.downloadWillBegin', {
    url: 'https://a.test/file',
    suggestedFilename: 'file.pdf',
  });
  assert.equal(second.length, 1);
});

test('下载/导出任务会在点击前被识别', () => {
  assert.equal(shouldObserveDownloads('把这个月的报表导出来'), true);
  assert.equal(shouldObserveDownloads('download the report'), true);
  assert.equal(shouldObserveDownloads('把页面标题加粗'), false);
});
