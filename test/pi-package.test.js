const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolvePiInstall, resolvePiRoot, piVersion } = require('../lib/pi-package');

const PKG_NAME = '@earendil-works/pi-coding-agent';

const made = [];
/** 每个测试都在独立临时目录里造数据，绝不碰真实的 ~/.pi 或 APPDATA */
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** 隔离 env：HOME / PI_AGENT_DIR 指向不存在的临时路径，杜绝真实全局安装被探到 */
function baseEnv(tag) {
  const base = tmp('pi-pkg-env-' + tag + '-');
  return {
    USERPROFILE: path.join(base, 'home'),
    HOME: path.join(base, 'home'),
    PI_AGENT_DIR: path.join(base, 'agent'),
  };
}

function writePiPackage(dir, opts = {}) {
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  if (opts.dist !== false) fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: opts.name === undefined ? PKG_NAME : opts.name, version: opts.version || '0.0.0' })
  );
  return dir;
}

/** 造一个标准托管安装的某个 release，返回包目录 */
function makeRelease(root, version, opts = {}) {
  const dir = path.join(root, 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
  writePiPackage(dir, { version: opts.pkgVersion || version, name: opts.name, dist: opts.dist });
  return dir;
}

/** 找一个 PATH 里肯定没有的 shim 注入器 */
function noShim() {
  return () => null;
}

describe('pi-package: 托管安装识别', () => {
  it('按 current-version 命中 releases/<v> 里的包目录', () => {
    const root = tmp('pi-managed-');
    fs.writeFileSync(path.join(root, 'managed-install.json'), JSON.stringify({
      kind: 'pi-managed-install',
      schemaVersion: 1,
      layout: 'releases-v1',
    }));
    fs.writeFileSync(path.join(root, 'current-version'), '1.4.2\n');
    const pkgDir = makeRelease(root, '1.4.2', { pkgVersion: '1.4.2' });
    makeRelease(root, '1.10.0', { pkgVersion: '1.10.0' }); // 更新的版本也不该被选中

    const r = resolvePiInstall({ env: { ...baseEnv('current'), PI_MANAGED_INSTALL_ROOT: root }, whichPi: noShim() });
    assert.equal(r.kind, 'managed-install');
    assert.equal(r.root, pkgDir);
    assert.equal(r.version, '1.4.2');
    assert.equal(r.source, pkgDir);
  });

  it('current-version 缺失时选 releases 下版本号最大的目录，非 semver 名字排后面', () => {
    const root = tmp('pi-managed-');
    makeRelease(root, '1.9.0');
    const biggest = makeRelease(root, '1.10.0');
    makeRelease(root, 'nightly');

    const r = resolvePiInstall({ env: { ...baseEnv('maxver'), PI_MANAGED_INSTALL_ROOT: root }, whichPi: noShim() });
    assert.equal(r.kind, 'managed-install');
    assert.equal(r.root, biggest);
    assert.equal(r.version, '1.10.0');
  });

  it('current-version 指向不可用目录时回退到最大版本目录', () => {
    const root = tmp('pi-managed-');
    fs.writeFileSync(path.join(root, 'current-version'), '9.9.9');
    const good = makeRelease(root, '1.2.3');
    const r = resolvePiInstall({ env: { ...baseEnv('fallback'), PI_MANAGED_INSTALL_ROOT: root }, whichPi: noShim() });
    assert.equal(r.kind, 'managed-install');
    assert.equal(r.root, good);
  });

  it('缺 dist/index.js 的 release 跳过', () => {
    const root = tmp('pi-managed-');
    makeRelease(root, '2.0.0', { dist: false });
    const good = makeRelease(root, '1.0.0');
    const r = resolvePiInstall({ env: { ...baseEnv('nodist'), PI_MANAGED_INSTALL_ROOT: root }, whichPi: noShim() });
    assert.equal(r.kind, 'managed-install');
    assert.equal(r.root, good);
  });

  it('package.json 的 name 不匹配时视为不匹配', () => {
    const root = tmp('pi-managed-');
    makeRelease(root, '1.0.0', { name: 'some-other-package' });
    const r = resolvePiInstall({ env: { ...baseEnv('badname'), PI_MANAGED_INSTALL_ROOT: root }, whichPi: noShim() });
    assert.equal(r.root, null);
    assert.equal(r.kind, null);
  });
});

describe('pi-package: 候选优先级', () => {
  it('PI_PKG_DIR 优先于托管安装', () => {
    const envRoot = tmp('pi-env-');
    const envDir = writePiPackage(path.join(envRoot, 'pkg'), { version: '0.1.0' });
    const managedRoot = tmp('pi-managed-');
    fs.writeFileSync(path.join(managedRoot, 'current-version'), '1.0.0');
    makeRelease(managedRoot, '1.0.0');

    const r = resolvePiInstall({
      env: { ...baseEnv('prio'), PI_PKG_DIR: envDir, PI_MANAGED_INSTALL_ROOT: managedRoot },
      whichPi: noShim(),
    });
    assert.equal(r.kind, 'env');
    assert.equal(r.root, envDir);
    assert.equal(r.version, '0.1.0');
    assert.equal(r.source, envDir);
  });

  it('npm 全局候选返回 npm-global', () => {
    const appdata = tmp('pi-appdata-');
    const dir = writePiPackage(path.join(appdata, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent'), { version: '2.3.4' });
    const r = resolvePiInstall({ env: { ...baseEnv('npm'), APPDATA: appdata }, whichPi: noShim() });
    assert.equal(r.kind, 'npm-global');
    assert.equal(r.root, dir);
    assert.equal(r.version, '2.3.4');
  });
});

describe('pi-package: shim 兜底与安全返回', () => {
  it('PATH 里没有 pi 时安全返回 null，不抛异常', () => {
    const r = resolvePiInstall({ env: baseEnv('noshim'), whichPi: () => null });
    assert.deepEqual(r, { root: null, kind: null, version: '', source: null });
    assert.equal(resolvePiRoot(), resolvePiInstall().root);
  });

  it('从 shim 文本的 node_modules 片段反推包目录', () => {
    const shimDir = tmp('pi-shim-');
    const pkgDir = writePiPackage(path.join(shimDir, 'node_modules', '@earendil-works', 'pi-coding-agent'), { version: '3.1.4' });
    const shim = path.join(shimDir, 'pi.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\nendLocal & "%_prog%" "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n');

    const r = resolvePiInstall({ env: baseEnv('shim'), whichPi: () => shim });
    assert.equal(r.kind, 'shim');
    assert.equal(r.root, pkgDir);
    assert.equal(r.version, '3.1.4');
    assert.equal(r.source, shim);
  });

  it('shim 文本提取不到时从脚本目录向上找同名包', () => {
    const pkgDir = tmp('pi-shimup-');
    writePiPackage(pkgDir, { version: '4.0.0' });
    const binDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, 'pi');
    fs.writeFileSync(shim, '#!/bin/sh\nexec node "$(dirname "$0")/../dist/cli.js" "$@"\n');

    const r = resolvePiInstall({ env: baseEnv('shimup'), whichPi: () => shim });
    assert.equal(r.kind, 'shim');
    assert.equal(r.root, pkgDir);
  });
});

describe('pi-package: 不误判', () => {
  it('同一个 managed root 认不出时不会误判成 npm-global', () => {
    const root = tmp('pi-managed-');
    fs.writeFileSync(path.join(root, 'managed-install.json'), JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' }));
    // release 存在但内容不是 pi 包
    fs.mkdirSync(path.join(root, 'releases', '1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(root, 'releases', '1.0.0', 'package.json'), JSON.stringify({ name: 'not-pi' }));

    const r = resolvePiInstall({ env: { ...baseEnv('misjudge'), PI_MANAGED_INSTALL_ROOT: root }, whichPi: noShim() });
    assert.equal(r.root, null);
    assert.equal(r.kind, null);
    assert.equal(r.version, '');
  });

  it('piVersion 读不到时返回空串', () => {
    assert.equal(piVersion(path.join(tmp('pi-none-'), 'nope')), '');
  });
});
