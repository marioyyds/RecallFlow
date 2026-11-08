#!/usr/bin/env node
// Download and extract the external data required by the full WebArena suite.
// Data stays outside Docker so it does not inflate the Docker Desktop VHDX.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAP_TARS = [
  {
    name: 'osm',
    url: 'https://webarena-map-server-data.s3.amazonaws.com/osm_tile_server.tar',
  },
  {
    name: 'nominatim',
    url: 'https://webarena-map-server-data.s3.amazonaws.com/nominatim_volumes.tar',
  },
  {
    name: 'routing',
    url: 'https://webarena-map-server-data.s3.amazonaws.com/osrm_routing.tar',
  },
];

const WIKIPEDIA_URL =
  'https://archive.org/download/wikipedia_en_all_maxi_2022-05/wikipedia_en_all_maxi_2022-05.zim';
const WIKIPEDIA_NAME = 'wikipedia_en_all_maxi_2022-05.zim';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const proxy = arg('--proxy', process.env.HTTPS_PROXY || '');
const baseDir = path.resolve(arg('--data-dir', 'D:/WebArenaData'));
const only = arg('--only', 'all');
const mapDir = path.join(baseDir, 'map');
const wikiDir = path.join(baseDir, 'wikipedia');
const downloadDir = path.join(baseDir, '.downloads');
const aria2 = arg('--aria2', process.env.ARIA2C || 'aria2c.exe');

function ariaArgs(url, output) {
  const args = [
    '--continue=true',
    '--allow-overwrite=true',
    '--auto-file-renaming=false',
    '--file-allocation=none',
    '--max-tries=5',
    '--retry-wait=3',
    '-x', '16',
    '-s', '16',
    '-k', '1M',
    '--dir', downloadDir,
    '--out', output,
  ];
  if (proxy) args.push('--all-proxy=' + proxy);
  return [...args, url];
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${code})`));
    });
  });
}

function download(url, name) {
  fs.mkdirSync(downloadDir, { recursive: true });
  return runProcess(aria2, ariaArgs(url, name)).then(() => path.join(downloadDir, name));
}

async function downloadAndExtract(url, name, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const archive = await download(url, name);
  console.log(`[webarena-data] extracting ${archive} -> ${destination}`);
  await runProcess('tar.exe', ['-xf', archive, '-C', destination]);
  fs.unlinkSync(archive);
}

async function downloadResumable(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = path.join(downloadDir, path.basename(destination));
  fs.mkdirSync(downloadDir, { recursive: true });
  if (fs.existsSync(destination) && fs.statSync(destination).size < 80 * 1024 ** 3) {
    fs.unlinkSync(destination);
  }
  await runProcess(aria2, ariaArgs(url, path.basename(destination)));
  fs.renameSync(partial, destination);
}

async function main() {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  const mapItems = only === 'map' || only === 'all'
    ? MAP_TARS
    : MAP_TARS.filter((item) => only === 'map-' + item.name);
  if (mapItems.length) {
    for (const item of mapItems) {
      console.log(`[webarena-data] extracting map ${item.name}: ${item.url}`);
      const name = path.basename(new URL(item.url).pathname);
      await downloadAndExtract(item.url, name, mapDir);
    }
  }
  if (only === 'all' || only === 'wikipedia') {
    const output = path.join(wikiDir, WIKIPEDIA_NAME);
    console.log(`[webarena-data] downloading Wikipedia: ${WIKIPEDIA_URL}`);
    await downloadResumable(WIKIPEDIA_URL, output);
    const stat = fs.statSync(output);
    if (stat.size < 80 * 1024 ** 3) {
      throw new Error(`Wikipedia ZIM is unexpectedly small: ${stat.size}`);
    }
  }
  console.log('[webarena-data] complete');
}

main().catch((error) => {
  console.error('[webarena-data] failed:', error);
  process.exit(1);
});
