// 夜间 E2E 前置检查的浏览器目录解析（L-26）。
//
// 起因：`scripts/run-e2e.mjs` 把浏览器目录写死成 Windows 的
// `~/AppData/Local/ms-playwright`，Linux runner 上永远找不到 Chromium，
// `e2e-nightly` 从上线起每次都 exit 2 —— 门禁配了却一次都没真跑过，也没人发现。
// 这里把「目录怎么解析」钉住：平台默认值必须随平台变，非 Windows 上绝不能再出现 `AppData`。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveBrowsersPath } from '../scripts/run-e2e.mjs';

const HOME = path.join(path.sep, 'home', 'runner');

test('PLAYWRIGHT_BROWSERS_PATH 优先于平台默认值（显式指定时不再猜路径）', () => {
  const p = resolveBrowsersPath({
    platform: 'linux',
    env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' },
    homedir: HOME,
  });
  assert.equal(p, '/opt/pw-browsers');
});

test('linux 下解析到 ~/.cache/ms-playwright，且绝不能再出现 AppData', () => {
  // 这条就是本次回归的门禁：旧实现在 Linux 上会返回 <home>/AppData/Local/ms-playwright，
  // Playwright 实际装在 ~/.cache/ms-playwright，于是永远报"未找到 Chromium"。
  const p = resolveBrowsersPath({ platform: 'linux', env: {}, homedir: HOME });
  assert.equal(p, path.join(HOME, '.cache', 'ms-playwright'));
  assert.ok(!p.includes('AppData'), 'Linux 上不该解析出 Windows 的 AppData 目录：' + p);
});

test('darwin 下解析到 ~/Library/Caches/ms-playwright', () => {
  const p = resolveBrowsersPath({ platform: 'darwin', env: {}, homedir: HOME });
  assert.equal(p, path.join(HOME, 'Library', 'Caches', 'ms-playwright'));
  assert.ok(!p.includes('AppData'), 'macOS 上不该解析出 Windows 的 AppData 目录：' + p);
});

test('win32 下仍解析到 ~/AppData/Local/ms-playwright（锁住既有行为）', () => {
  const p = resolveBrowsersPath({ platform: 'win32', env: {}, homedir: HOME });
  assert.equal(p, path.join(HOME, 'AppData', 'Local', 'ms-playwright'));
});

test('显式指定的 PLAYWRIGHT_BROWSERS_PATH 在 win32 上同样优先', () => {
  const p = resolveBrowsersPath({
    platform: 'win32',
    env: { PLAYWRIGHT_BROWSERS_PATH: 'D:/pw-browsers' },
    homedir: HOME,
  });
  assert.equal(p, 'D:/pw-browsers');
});
