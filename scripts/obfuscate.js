const fs = require('fs');
const path = require('path');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function copyDir(srcDir, dstDir) {
  ensureDir(dstDir);
  const items = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const it of items) {
    const src = path.join(srcDir, it.name);
    const dst = path.join(dstDir, it.name);
    if (it.isDirectory()) copyDir(src, dst);
    else copyFile(src, dst);
  }
}

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    const items = fs.readdirSync(d, { withFileTypes: true });
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const srcDir = path.join(root, 'src');
  const outDir = path.join(root, 'dist-obf');

  const obfuscator = require('javascript-obfuscator');

  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  ensureDir(outDir);

  // Copy everything first
  copyDir(srcDir, outDir);

  // Obfuscate .js files (except vendor bundles)
  const files = walk(outDir)
    .filter((p) => p.toLowerCase().endsWith('.js'))
    .filter((p) => !/skinview3d\.bundle\.js$/i.test(p));

  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const res = obfuscator.obfuscate(code, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.75,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.2,
      debugProtection: true,
      debugProtectionInterval: true,
      disableConsoleOutput: true,
      identifierNamesGenerator: 'hexadecimal',
      renameGlobals: false,
      selfDefending: true,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.75,
      unicodeEscapeSequence: false,
    });
    fs.writeFileSync(file, res.getObfuscatedCode(), 'utf8');
  }

  process.stdout.write(`Obfuscated build written to: ${outDir}\n`);
}

main();
