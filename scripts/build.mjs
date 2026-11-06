/* ==========================================================================
 * 构建：把共享排程内核 + 浏览器半侧源码拼成 DSH 可加载的单文件 bundle。
 *
 *   src/scheduler.js   → lib/scheduler.js（宿主 import）+ 内联进 client
 *   src/host.js        → lib/index.js
 *   src/client/*.js    → lib/client.js（按文件名排序拼接，同一 factory 作用域）
 *
 * 浏览器 bundle 必须是「普通副作用脚本」：顶层调用
 * window.__ModuleLoader__.load({ id, factory(require) })；react 由平台的
 * 种子模块表提供，所以这里不打包 react。
 * ========================================================================== */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptsDir, '..');
const srcDir = join(root, 'src');
const libDir = join(root, 'lib');

mkdirSync(libDir, { recursive: true });

const schedulerSource = readFileSync(join(srcDir, 'scheduler.js'), 'utf8');
const schedulerInline = schedulerSource.replace(/^export\s+/gm, '');

const clientFiles = readdirSync(join(srcDir, 'client'))
  .filter((name) => name.endsWith('.js'))
  .sort();

if (clientFiles.length === 0) {
  console.error('build: src/client 下没有可拼接的源码');
  process.exit(1);
}

const clientBody = clientFiles
  .map((name) => {
    const code = readFileSync(join(srcDir, 'client', name), 'utf8');
    return '/* ---- ' + name + ' ---- */\n' + code;
  })
  .join('\n\n');

const bundle = `/* dsh-taskboard 浏览器半侧 · 由 scripts/build.mjs 生成，请改 src/ 里的源码 */
window.__ModuleLoader__.load({
  id: 'dsh-taskboard',
  factory(require) {
'use strict';

${schedulerInline}

${clientBody}
  },
});
`;

const clientOut = join(libDir, 'client.js');
writeFileSync(clientOut, bundle, 'utf8');

copyFileSync(join(srcDir, 'scheduler.js'), join(libDir, 'scheduler.js'));
copyFileSync(join(srcDir, 'host.js'), join(libDir, 'index.js'));

// 至少保证产物能被 Node 解析；运行期依赖（window / react）由 DSH 提供。
try {
  execFileSync(process.execPath, ['--check', clientOut], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', join(libDir, 'index.js')], { stdio: 'pipe' });
} catch (error) {
  console.error('build: 产物语法检查失败');
  console.error((error.stderr && error.stderr.toString()) || error.message);
  process.exit(1);
}

const clientBytes = Buffer.byteLength(bundle);
console.log(
  'build ok: lib/client.js (' +
    (clientBytes / 1024).toFixed(1) +
    ' KiB, ' +
    clientFiles.length +
    ' 个源码段) · lib/index.js · lib/scheduler.js',
);
