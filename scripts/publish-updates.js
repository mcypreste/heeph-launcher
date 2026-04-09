const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return '';
  return String(process.argv[idx + 1] || '').trim();
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function sha256HexFile(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function requireFile(p, label) {
  if (!p) throw new Error(`${label} path is required.`);
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: false, ...opts });
  if (r.error) throw r.error;
  if (typeof r.status === 'number' && r.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

function main() {
  const repo = argValue('--repo') || 'mcypreste/heeph-launcher-updates';
  const tag = argValue('--tag');
  const jarPath = argValue('--jar');
  const jsonPathArg = argValue('--json');
  const updatesVercelDir = argValue('--updatesVercelDir') || path.resolve(__dirname, '..', 'updates-vercel');
  const writeVercel = hasFlag('--write-vercel');

  if (!tag) throw new Error('Missing --tag (example: v21).');

  requireFile(jarPath, 'JAR');
  const jsonPath = jsonPathArg || jarPath.replace(/\.jar$/i, '.json');
  requireFile(jsonPath, 'JSON');

  const tmpDir = path.join(process.env.TEMP || process.cwd(), `heeph-release-${tag}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const jarOut = path.join(tmpDir, 'heeph-1.8.9.jar');
  const jsonOut = path.join(tmpDir, 'heeph-1.8.9.json');
  fs.copyFileSync(jarPath, jarOut);
  fs.copyFileSync(jsonPath, jsonOut);

  const jarSha256 = sha256HexFile(jarOut);
  const jsonSha256 = sha256HexFile(jsonOut);

  const zipPath = path.join(tmpDir, 'heeph.zip');
  const zip = new AdmZip();
  zip.addLocalFile(jarOut, '', 'heeph-1.8.9.jar');
  zip.addLocalFile(jsonOut, '', 'heeph-1.8.9.json');
  zip.writeZip(zipPath);

  const manifest = {
    version: tag,
    zipUrl: 'heeph.zip',
    jarSha256,
    jsonSha256,
  };
  const manifestPath = path.join(tmpDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  run('gh', ['--version']);
  run('gh', ['auth', 'status']);

  let exists = false;
  try {
    const r = spawnSync('gh', ['release', 'view', tag, '-R', repo], { stdio: 'ignore', windowsHide: true });
    exists = (r.status === 0);
  } catch (_) {
    exists = false;
  }

  if (exists) {
    run('gh', ['release', 'upload', tag, manifestPath, zipPath, '-R', repo, '--clobber']);
    run('gh', ['release', 'edit', tag, '-R', repo, '--title', tag, '--latest']);
  } else {
    run('gh', ['release', 'create', tag, manifestPath, zipPath, '-R', repo, '--title', tag, '--notes', `Client update ${tag}`, '--latest']);
  }

  if (writeVercel) {
    if (!fs.existsSync(updatesVercelDir)) throw new Error(`updates-vercel dir not found: ${updatesVercelDir}`);
    fs.copyFileSync(manifestPath, path.join(updatesVercelDir, 'manifest.json'));
    const vercelZip = path.join(updatesVercelDir, 'heeph-1.8.9.zip');
    fs.copyFileSync(zipPath, vercelZip);
  }

  process.stdout.write(`\nOK\nrepo=${repo}\ntag=${tag}\nzip=${zipPath}\nmanifest=${manifestPath}\njarSha256=${jarSha256}\njsonSha256=${jsonSha256}\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`\nERROR: ${e.message || String(e)}\n`);
  process.exit(1);
}
