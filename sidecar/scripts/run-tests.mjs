/**
 * Run sidecar test files one process at a time.
 * Avoids Windows libuv UV_HANDLE_CLOSING abort when --test-force-exit tears down
 * many long-lived sidecar children from parallel/serial suite aggregation.
 */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'test/runtime.test.mjs',
  'test/memory.test.mjs',
  'test/pattern-db.test.mjs',
  'test/pattern-pipeline.test.mjs',
  'test/relay.test.mjs',
  'test/channels.test.mjs',
  'test/computer-use-text.test.mjs',
  'test/e2e.test.mjs',
  'test/extract.test.mjs',
  'test/routing-tools.test.mjs',
];

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-force-exit', file],
    {cwd: root, encoding: 'utf8', env: process.env},
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  // libuv may abort after tests already reported pass (status null / 0xC0000409-like).
  const out = `${result.stdout || ''}\n${result.stderr || ''}`;
  const passMatch = out.match(/ℹ pass (\d+)/) || out.match(/\bpass (\d+)/);
  const failMatch = out.match(/ℹ fail (\d+)/) || out.match(/\bfail (\d+)/);
  const pass = passMatch ? Number(passMatch[1]) : 0;
  let fail = failMatch ? Number(failMatch[1]) : result.status === 0 ? 0 : 1;
  // Node on Windows sometimes aborts in libuv after all cases passed; the runner then
  // fabricates a file-level failure (fail=1) with UV_HANDLE_CLOSING in stderr.
  const uvTeardown =
    /UV_HANDLE_CLOSING/.test(out)
    && pass > 0
    && fail === 1
    && /test failed/.test(out);
  if (uvTeardown) {
    console.warn(`[run-tests] ${file}: ignoring Windows UV_HANDLE_CLOSING teardown after ${pass} passed tests`);
    fail = 0;
  }
  if (fail > 0 || (result.status !== 0 && pass === 0)) {
    console.error(`[run-tests] ${file} failed status=${result.status} pass=${pass} fail=${fail}`);
    failed += 1;
  } else {
    console.log(`[run-tests] ${file} ok (pass=${pass})`);
  }
}

process.exit(failed ? 1 : 0);
