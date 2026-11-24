const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const webDir = path.join(rootDir, 'apps', 'web');
const rootDist = path.join(rootDir, 'dist');
const webDist = path.join(webDir, 'dist');

console.log('--- [Qemma ERP Build] Building Frontend ---');
console.log('Working Directory:', webDir);

execSync('npm install', { cwd: webDir, stdio: 'inherit' });
execSync('npm run build', { cwd: webDir, stdio: 'inherit' });

if (fs.existsSync(webDist)) {
  fs.cpSync(webDist, rootDist, { recursive: true });
  console.log('--- [Qemma ERP Build] Successfully copied dist to root ---');
}
