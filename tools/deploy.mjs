import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(' ');
  console.log(`\n$ ${printable}`);
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });
}

function parseArgs(argv) {
  const options = {
    host: process.env.ROADMAP_DEPLOY_HOST || process.env.MEMORY_DEPLOY_HOST || 'rcadmin@10.32.56.212',
    remoteDir: process.env.ROADMAP_DEPLOY_PATH || process.env.MEMORY_DEPLOY_PATH || '/Users/rcadmin/personal-ai',
    skipLocalBuild: false,
    skipSync: false,
    noCache: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host' && argv[index + 1]) {
      options.host = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--remote-dir' && argv[index + 1]) {
      options.remoteDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--skip-local-build') {
      options.skipLocalBuild = true;
      continue;
    }
    if (arg === '--skip-sync') {
      options.skipSync = true;
      continue;
    }
    if (arg === '--no-cache') {
      options.noCache = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const sshArgs = ['-o', 'StrictHostKeyChecking=accept-new'];
const rsyncSsh = `ssh ${sshArgs.join(' ')}`;

if (!options.skipSync && !options.skipLocalBuild) {
  run('npm', ['run', 'build']);
}

if (!options.skipSync) {
  // The current host still builds this service from personal-ai/docker-compose.yml
  // with context ./roadmap-service. Sync this repo into that directory and leave
  // the parent compose (and memory-service) untouched.
  run('rsync', [
    '-az',
    '--delete',
    '--exclude',
    '.git/',
    '--exclude',
    '.env',
    '--exclude',
    'data/',
    '--exclude',
    'node_modules/',
    '--exclude',
    'coverage/',
    '--exclude',
    '.DS_Store',
    '-e',
    rsyncSsh,
    `${repoRoot}/`,
    `${options.host}:${options.remoteDir}/roadmap-service/`,
  ]);
} else {
  console.log('\nSkipping source sync; rebuilding the existing remote worktree.');
}

const remoteSteps = [
  'set -euo pipefail',
  'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"',
  `cd ${shellQuote(options.remoteDir)}`,
  'test -f docker-compose.yml',
  'test -f roadmap-service/Dockerfile',
  `docker compose build${options.noCache ? ' --no-cache' : ''} roadmap-service`,
  'docker compose stop roadmap-service 2>/dev/null || true',
  'docker compose rm -f -s roadmap-service 2>/dev/null || true',
  'docker rm -f roadmap-service 2>/dev/null || true',
  'for id in $(docker ps -a --filter name=roadmap-service -q); do docker rm -f "$id" || true; done',
  'docker compose up -d --force-recreate --remove-orphans roadmap-service',
  'for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:3220/health >/dev/null && break; sleep 2; done',
  'curl -fsS http://127.0.0.1:3220/health >/dev/null',
  'docker compose ps roadmap-service',
  shellQuote(`${options.remoteDir}/tools/server-public-stack-watchdog.sh`),
];

run('ssh', [
  ...sshArgs,
  options.host,
  `bash -lc ${shellQuote(remoteSteps.join(' && '))}`,
]);

console.log('\nRoadmap service deploy completed.');
