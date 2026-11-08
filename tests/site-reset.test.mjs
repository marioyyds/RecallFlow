import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEBARENA_ORIGINAL_SITE_CONTAINERS,
  WEBARENA_SITE_CONTAINERS,
  buildDockerRunArgs,
} from '../integrations/webarena/site-reset.mjs';

test('site reset：六个站点都映射到带固定端口的官方镜像', () => {
  assert.deepEqual(
    Object.keys(WEBARENA_SITE_CONTAINERS).sort(),
    ['gitlab', 'map', 'reddit', 'shopping', 'shopping_admin', 'wikipedia']
  );
  const shopping = buildDockerRunArgs('shopping');
  assert.equal(shopping[0], 'run');
  assert.ok(shopping.includes('webarena-verified-shopping'));
  assert.ok(shopping.includes('7770:80'));
  assert.ok(shopping.includes('WA_ENV_CTRL_TYPE=shopping'));
  assert.equal(shopping.at(-1), 'am1n3e/webarena-verified-shopping:latest');
});

test('site reset：未知站点明确报错，不静默跳过', () => {
  assert.throws(() => buildDockerRunArgs('homepage'), /没有配置/);
});

test('site reset：GitLab 使用 8023 和独立 env-ctrl 端口', () => {
  const gitlab = buildDockerRunArgs('gitlab');
  assert.ok(gitlab.includes('8023:8023'));
  assert.ok(gitlab.includes('8024:8877'));
  assert.ok(gitlab.includes('WA_ENV_CTRL_TYPE=gitlab'));
  assert.equal(gitlab.at(-1), 'am1n3e/webarena-verified-gitlab:latest');
});

test('site reset：原始 WebArena 三站镜像与容器名独立配置', () => {
  assert.deepEqual(
    Object.keys(WEBARENA_ORIGINAL_SITE_CONTAINERS).sort(),
    ['reddit', 'shopping', 'shopping_admin']
  );
  const shopping = buildDockerRunArgs('shopping', { imageSet: 'original' });
  assert.ok(shopping.includes('webarena-original-shopping'));
  assert.equal(shopping.at(-1), 'webarenaimages/shopping_final_0712:latest');
  const reddit = buildDockerRunArgs('reddit', { imageSet: 'original' });
  assert.equal(reddit.at(-1), 'webarenaimages/postmill-populated-exposed-withimg:latest');
});
