import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyRemoteDir = '/Users/rcadmin/personal-ai/roadmap-service';
const watchdogPath = '/Users/rcadmin/personal-ai/tools/server-public-stack-watchdog.sh';

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
    remoteDir: process.env.ROADMAP_DEPLOY_PATH || '/Users/rcadmin/personal-roadmap',
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
  run('ssh', [...sshArgs, options.host, `mkdir -p ${shellQuote(options.remoteDir)}`]);
  // Dockerfile copies prebuilt dist/ + web/dist/ (no in-image tsc/vite).
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
    `${options.host}:${options.remoteDir}/`,
  ]);
} else {
  console.log('\nSkipping source sync; rebuilding the existing remote worktree.');
}

const remoteSteps = [
  'set -euo pipefail',
  'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"',
  `NEW_DIR=${shellQuote(options.remoteDir)}`,
  `OLD_DIR=${shellQuote(legacyRemoteDir)}`,
  `WATCH=${shellQuote(watchdogPath)}`,
  'python3 - "$WATCH" <<\'PY\'',
  'import pathlib, sys',
  'path = pathlib.Path(sys.argv[1])',
  'if not path.exists():',
  '    print("[deploy] watchdog script not on host; skipped")',
  'else:',
  '    text = path.read_text()',
  '    orig = text',
  '    needle = \'PERSONAL_AI_DIR="/Users/rcadmin/personal-ai"\\n\'',
  '    insert = needle + \'ROADMAP_DIR="/Users/rcadmin/personal-roadmap"\\n\'',
  '    if "ROADMAP_DIR=" not in text and needle in text:',
  '        text = text.replace(needle, insert, 1)',
  '    old_fn = """ensure_core_services() {',
  '  if [[ -d "$PERSONAL_AI_DIR" ]]; then',
  '    (',
  '      cd "$PERSONAL_AI_DIR"',
  '      docker compose up -d roadmap-service memory-service 2>/dev/null || true',
  '    )',
  '  fi',
  '}"""',
  '    new_fn = """ensure_core_services() {',
  '  if [[ -d "$ROADMAP_DIR" ]]; then',
  '    (cd "$ROADMAP_DIR" && docker compose up -d roadmap-service) || true',
  '  fi',
  '  if [[ -d "$PERSONAL_AI_DIR" ]]; then',
  '    (cd "$PERSONAL_AI_DIR" && docker compose up -d memory-service) || true',
  '  fi',
  '}"""',
  '    if old_fn in text:',
  '        text = text.replace(old_fn, new_fn, 1)',
  '    old_recreate = \'(cd "$PERSONAL_AI_DIR" && docker compose up -d --force-recreate roadmap-service)\'',
  '    new_recreate = \'(cd "$ROADMAP_DIR" && docker compose up -d --force-recreate roadmap-service)\'',
  '    if old_recreate in text:',
  '        text = text.replace(old_recreate, new_recreate, 1)',
  '    if text != orig:',
  '        path.write_text(text)',
  '        print("[deploy] watchdog now starts roadmap from /Users/rcadmin/personal-roadmap")',
  '    else:',
  '        print("[deploy] watchdog already points at the roadmap repo")',
  'PY',
  'if [ -f /Users/rcadmin/personal-ai/docker-compose.yml ]; then',
  '  (cd /Users/rcadmin/personal-ai && docker compose stop roadmap-service) || true',
  '  (cd /Users/rcadmin/personal-ai && docker compose rm -f -s roadmap-service) || true',
  'fi',
  'docker rm -f roadmap-service >/dev/null 2>&1 || true',
  'if [ ! -f "$NEW_DIR/.env" ] && [ -f "$OLD_DIR/.env" ]; then',
  '  cp "$OLD_DIR/.env" "$NEW_DIR/.env"',
  '  echo "[deploy] copied .env from the previous roadmap directory"',
  'fi',
  'if [ ! -d "$NEW_DIR/data" ] || [ -z "$(ls -A "$NEW_DIR/data" 2>/dev/null || true)" ]; then',
  '  if [ -d "$OLD_DIR/data" ]; then',
  '    mkdir -p "$NEW_DIR/data"',
  '    rsync -a "$OLD_DIR/data/" "$NEW_DIR/data/"',
  '    echo "[deploy] copied data/ from the previous roadmap directory"',
  '  fi',
  'fi',
  'cd "$NEW_DIR"',
  'test -f docker-compose.yml',
  'test -f Dockerfile',
  `docker compose build${options.noCache ? ' --no-cache' : ''} roadmap-service`,
  'docker compose up -d --force-recreate --remove-orphans roadmap-service',
  'for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:3220/health >/dev/null && break; sleep 2; done',
  'curl -fsS http://127.0.0.1:3220/health >/dev/null',
  'docker compose ps roadmap-service',
  'if [ -x "$WATCH" ]; then "$WATCH" || true; fi',
];

run('ssh', [
  ...sshArgs,
  options.host,
  `bash -lc ${shellQuote(remoteSteps.join('\n'))}`,
]);

console.log('\nRoadmap service deploy completed.');
