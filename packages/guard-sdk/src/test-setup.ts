/**
 * Vitest setup for guard-sdk: let the worker's event loop turn after every test.
 *
 * The differential and fuzz tests (dlp-linear.test.ts and others) are synchronous. Vitest runs one file's synchronous
 * tests back to back without a macrotask turn, so the worker never reads the replies to its progress RPCs
 * ("onTaskUpdate") until the file ends. Those calls time out after 60 s (birpc's default), and on a busy 2-core CI
 * runner dlp-linear.test.ts alone takes about 60 s: the run then fails with
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` although every test passed. One setImmediate per test delivers
 * the replies, so only a single test longer than 60 s could still hit the limit. Nothing the tests check changes.
 */
import { afterEach } from "vitest";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
