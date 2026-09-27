import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

const pkg = JSON.parse(read('package.json'));
if (pkg.license !== 'Apache-2.0') {
  throw new Error(`package.json license must stay Apache-2.0, got ${pkg.license ?? 'missing'}`);
}

const license = read('LICENSE');
if (!license.startsWith('Apache License\n') || !license.includes('Version 2.0, January 2004') || !license.includes('3. Grant of Patent License.')) {
  throw new Error('LICENSE is not the expected Apache License 2.0 text');
}

const notice = read('NOTICE');
if (!notice.includes('ProdDoctor') || !notice.includes('Copyright 2026 Lucas Lu')) {
  throw new Error('NOTICE is missing ProdDoctor copyright attribution');
}

for (const path of ['README.md', 'README.zh-CN.md']) {
  const readme = read(path);
  if (!readme.includes('license-Apache--2.0') || !readme.includes('Apache License 2.0')) {
    throw new Error(`${path} does not advertise Apache License 2.0 consistently`);
  }
}

console.log('Apache-2.0 license policy verified');
