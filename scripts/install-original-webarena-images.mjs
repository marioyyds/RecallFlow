#!/usr/bin/env node
// Install the three original WebArena site images used by the 480-task subset.
// The registry is pulled by crane through the host proxy because Docker
// Desktop's VM proxy cannot reach Docker Hub in this environment.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const IMAGES = [
  'webarenaimages/shopping_final_0712:latest',
  'webarenaimages/shopping_admin_final_0719:latest',
  'webarenaimages/postmill-populated-exposed-withimg:latest',
];
const crane = process.env.CRANE_BIN || 'crane.exe';
const outputDir = path.resolve(process.env.WEBARENA_IMAGE_DIR || 'D:/WebArenaImages');
const proxy = process.env.HTTPS_PROXY || '';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(command + ' exited with ' + code));
    });
  });
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const image of IMAGES) {
    const name = image.replace(':latest', '').replaceAll('/', '-');
    const archive = path.join(outputDir, name + '.tar');
    if (fs.existsSync(archive)) fs.unlinkSync(archive);
    console.log('[webarena-image] pulling ' + image);
    const args = ['pull', '--platform', 'linux/amd64', '--format', 'legacy', image, archive];
    await run(crane, args);
    console.log('[webarena-image] loading ' + archive);
    await run('docker', ['load', '-i', archive]);
    fs.unlinkSync(archive);
    console.log('[webarena-image] installed ' + image);
  }
}

main().catch((error) => {
  console.error('[webarena-image] failed:', error);
  process.exit(1);
});
