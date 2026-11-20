#!/usr/bin/env node
'use strict';
/**
 * Demo: seeds a fake project with history + pending quizzes in a throwaway SKILLME_HOME and serves the Arena.
 *   node test/demo.js            -> http://127.0.0.1:4799
 * Answer quizzes in the browser; run again to reseed. Your real ~/.skillme data is untouched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = path.join(os.tmpdir(), 'skillme-demo');
const PROJ = path.join(HOME, 'shop-api');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true });
for (const f of ['src/auth/login.ts', 'src/auth/session.ts', 'src/cart/cart.service.ts', 'src/db/orders.repo.ts', 'src/http/server.ts', 'src/utils/retry.ts', 'web/Checkout.tsx', 'README.md']) {
  fs.mkdirSync(path.dirname(path.join(PROJ, f)), { recursive: true });
  fs.writeFileSync(path.join(PROJ, f), '// demo\n');
}
process.env.SKILLME_HOME = HOME;
process.env.SKILLME_PROJECT = PROJ;
const core = require('../server/core');

const P = (f) => path.join(PROJ, f);
core.updateState(PROJ, (s) => {
  core.refreshTotalFiles(s, PROJ);
  core.trackActivity(s, PROJ, P('src/http/server.ts'), 'read');
  core.trackActivity(s, PROJ, P('src/db/orders.repo.ts'), 'read');
  core.trackActivity(s, PROJ, P('src/auth/login.ts'), 'write', 48);
  core.trackActivity(s, PROJ, P('src/auth/session.ts'), 'write', 22);
  core.trackActivity(s, PROJ, P('src/utils/retry.ts'), 'write', 30);

  const add = (q) => {
    const r = core.pushQuiz(s, PROJ, q);
    if (!r.ok) throw new Error('demo quiz rejected: ' + r.errors.join('; '));
    return r.quiz;
  };
  const a = add({
    context: 'login() checks an email + password against the users table. Passwords are stored as bcrypt hashes, never as plain text.',
    question: 'Why does login() use bcrypt.compare instead of hashing and comparing strings?',
    options: ['It is faster', 'compare() re-hashes with the stored salt and compares in constant time', 'Hashes can be decrypted', 'Strings can\'t be compared in TS'],
    answer: 1, explanation: 'compare() extracts salt+cost from the stored hash and avoids timing leaks.',
    lesson: 'Hashes are one-way: you verify by re-hashing the input with the same salt, never by decrypting.',
    concept: 'password hashing', files: ['src/auth/login.ts'], difficulty: 2,
  });
  core.markShown(s, a.id); s.quizzes.find((q) => q.id === a.id).shownAt -= 9000;
  core.answerQuiz(s, a.id, a.answer);
  core.addThread(s, a.id, 'user', 'Does the cost factor matter for login speed?');
  core.addThread(s, a.id, 'tutor', 'Yes. The cost is stored in the hash itself ($2b$12$...), and compare() re-hashes at that cost, so cost 12 means about 4x the work of cost 10. That slowness is the point: it makes brute force expensive, at a cost of roughly 100-250 ms per login.', { model: 'anthropic/claude-sonnet-5.5' });

  const b = add({
    context: 'Sessions live in a signed cookie. session.ts configures it with maxAge: 15 min and rolling: true.',
    question: 'What happens to the session cookie after 15 minutes of inactivity?',
    options: ['Nothing', 'rolling expiry renews it on each request; idle sessions expire', 'It is deleted on the server only', 'The user is logged out of all devices'],
    answer: 1, explanation: 'rolling: true resets maxAge on every response, so only idle sessions expire.',
    concept: 'session expiry', files: ['src/auth/session.ts'], difficulty: 1,
  });
  core.answerQuiz(s, b.id, b.answer);

  const c = add({
    context: 'retry() wraps flaky network calls: it waits longer after each failure (exponential backoff) and adds a random amount to each wait.',
    question: 'Why does retry() add random jitter to the backoff delay?',
    options: ['To make tests flaky', 'To avoid many clients retrying in sync (thundering herd)', 'Because setTimeout is imprecise', 'To retry faster'],
    answer: 1, explanation: 'Jitter spreads retries out so a recovering service isn\'t hit by every client at the same instant.',
    lesson: 'Exponential backoff doubles the wait each attempt; jitter randomises it (e.g. delay * random(0.5..1.5)) so clients de-synchronise.',
    concept: 'retry backoff', files: ['src/utils/retry.ts'], difficulty: 2,
  });
  core.answerQuiz(s, c.id, (c.answer + 1) % 4);
  core.challengeQuiz(s, c.id, 'setTimeout drift is real too, and retry() has no max delay, so it can wait forever.', (c.answer + 1) % 4);
  core.resolveChallenge(s, c.id, 'human_right', 'You are partly right: the keyed answer is the main reason, but you spotted that retry() never caps the delay, which is a real bug.', {
    by: 'tutor', model: 'openrouter/auto', fix: 'src/utils/retry.ts:9: cap the delay, e.g. Math.min(base * 2 ** attempt, 30_000), before adding jitter.',
  });

  core.trackActivity(s, PROJ, P('src/cart/cart.service.ts'), 'write', 64);
  add({
    context: 'addItem() puts a product (sku) into a cart. Carts and items live in Postgres; (cartId, sku) has a unique index.',
    question: 'In the new addItem(), what happens if two requests add the same product at the same time?',
    code: 'async addItem(cartId: string, sku: string) {\n  await db.cartItem.upsert({\n    where: { cartId_sku: { cartId, sku } },\n    update: { qty: { increment: 1 } },\n    create: { cartId, sku, qty: 1 },\n  });\n}',
    language: 'ts',
    options: ['One request fails with a duplicate-key error', 'Both increment atomically thanks to the unique key + upsert', 'The quantity is overwritten to 1', 'The cart is duplicated'],
    answer: 1,
    explanation: 'The upsert targets the (cartId, sku) unique index and uses an atomic increment, so concurrent adds stack instead of clobbering.',
    lesson: 'Read-then-write ("find, then update qty+1") races under concurrency. Push the logic into one atomic DB operation (upsert + increment) backed by a unique constraint.',
    deep_dive: 'Picture two requests arriving 1 ms apart. With "find the row, then save qty + 1", both read qty = 1 and both write 2: one add is lost. upsert + increment sends a single statement (INSERT ... ON CONFLICT DO UPDATE SET qty = qty + 1), so the database serialises the two updates on the row and you end up with 3.',
    concept: 'race conditions', files: ['src/cart/cart.service.ts:12'], difficulty: 3,
  });
  add({
    context: 'Checkout.tsx is the browser page that sends the order. The server then creates the order and charges the card.',
    question: 'Why is the total computed on the server instead of trusting the price sent by Checkout.tsx?',
    options: ['Server math is more precise', 'Clients can tamper with request bodies', 'React can\'t do math', 'It\'s faster'],
    answer: 1, explanation: 'Anything from the browser can be edited; prices must come from the DB.',
    concept: 'never trust the client', files: ['web/Checkout.tsx'], difficulty: 1,
  });
});

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js'), '--arena', ...process.argv.slice(2)], {
  env: { ...process.env, SKILLME_PORT: process.env.SKILLME_PORT || '4799' }, stdio: 'inherit',
});
child.on('exit', (c) => process.exit(c || 0));
