import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindPanelWheelGuard,
  bindPanelWheelScroller,
  panelWheelDecision,
} from '../lib/ui/page/wheel-scroll.ts';

test('普通滚轮保留面板原生滚动', () => {
  assert.deepEqual(panelWheelDecision({ deltaY: -120 }), {
    blockPageZoom: false,
    allowNativeScroll: true,
    scrollUp: true,
  });
  assert.deepEqual(panelWheelDecision({ deltaY: 120 }), {
    blockPageZoom: false,
    allowNativeScroll: true,
    scrollUp: false,
  });
});

test('Ctrl/Meta wheel（含触控板捏合）拦截宿主页面缩放', () => {
  for (const event of [
    { ctrlKey: true, deltaY: -1 },
    { metaKey: true, deltaY: 1 },
  ]) {
    assert.deepEqual(panelWheelDecision(event), {
      blockPageZoom: true,
      allowNativeScroll: false,
      scrollUp: Number(event.deltaY) < 0,
    });
  }
});

test('监听器必须是非被动的，并同时阻断缩放与冒泡', () => {
  let listener = null;
  let options = null;
  const target = {
    addEventListener(_type, fn, opts) {
      listener = fn;
      options = opts;
    },
  };
  bindPanelWheelGuard(target);
  assert.equal(options.passive, false);
  let prevented = false;
  let stopped = false;
  listener({
    ctrlKey: true,
    deltaY: -10,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test('面板滚动监听器保留滚动意图并未漏掉被动配置', () => {
  let listener = null;
  let options = null;
  const intent = [];
  const target = {
    addEventListener(_type, fn, opts) {
      listener = fn;
      options = opts;
    },
  };
  bindPanelWheelScroller(target, (up) => intent.push(up));
  assert.equal(options.passive, false);
  listener({ deltaY: 120, preventDefault() {}, stopPropagation() {} });
  listener({ deltaY: -120, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(intent, [false, true]);
});
