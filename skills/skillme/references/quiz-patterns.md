# SkillMe quiz patterns

Short, about the *why*, tied to code you just touched. Each example is one item of `skillme_quiz`'s `quizzes` array. Always start with `context`: what the thing is in this project, in plain words.

## Bad → good rewrites

| Bad (trivia / vague) | Good (understanding) |
|---|---|
| "What is the name of the new function?" | "Why does `getCart()` read from the cache before hitting the DB?" |
| "Which file did I edit?" | "After my change, what happens when the token is expired?" |
| "Is this code good?" | "Which input makes `parseDate` throw now?" |
| "What does line 14 do?" (on obvious code) | "What would break if we removed the `finally` block?" |

## Examples

### JavaScript / React — predict
```json
{
  "context": "Profile.jsx shows the signed-in user. Its useEffect loads the user from the API whenever the profile page needs fresh data.",
  "question": "With the new deps array, when does this effect run?",
  "code": "useEffect(() => {\n  fetchUser(id).then(setUser);\n}, [id]);",
  "language": "jsx",
  "options": ["Only on first render", "On first render and whenever id changes", "On every render", "Only when setUser is called"],
  "answer": 1,
  "explanation": "The effect re-runs whenever a value in the deps array changes, plus once on mount. 'Every render' would need no deps array at all.",
  "lesson": "useEffect's dependency array is a change detector: React compares each value with the previous render (Object.is). [] = mount only, [a, b] = mount + when a or b change, no array = every render. Missing a dependency causes stale values; extra ones cause extra runs.",
  "concept": "React useEffect deps",
  "files": ["src/components/Profile.jsx:18"],
  "difficulty": 1
}
```

### Python — why
```json
{
  "context": "read_rows() is the first step of the import job: it reads the uploaded CSV and hands rows one by one to the validator.",
  "question": "Why did I use a generator instead of building a list in read_rows()?",
  "options": ["It's faster to write", "The CSV can be huge; rows stream one at a time instead of all in memory", "Lists can't hold dicts", "Generators can be indexed"],
  "answer": 1,
  "explanation": "A generator yields lazily, so memory stays flat for a 2 GB file. Generators actually can't be indexed — that's the trade-off.",
  "concept": "Python generators",
  "files": ["etl/reader.py"],
  "difficulty": 2
}
```

### SQL / backend — spot the risk
```json
{
  "context": "The order-history endpoint lists a user's past orders with the product name for each, using the Django ORM.",
  "question": "In the new order-history endpoint, what causes the most DB queries?",
  "code": "orders = Order.objects.filter(user=u)\nfor o in orders:\n    print(o.product.name)",
  "language": "python",
  "options": ["The filter() call", "Accessing o.product inside the loop (N+1 queries)", "print() flushing", "Django caching"],
  "answer": 1,
  "explanation": "Each o.product triggers its own query → 1 + N queries. select_related('product') turns it into one JOIN.",
  "lesson": "The N+1 problem: one query fetches N rows, then each row lazily loads a relation with its own query. ORMs fix it with eager loading (select_related / prefetch_related in Django, include in Prisma, joinedload in SQLAlchemy).",
  "concept": "SQL N+1",
  "files": ["api/views/orders.py:42"],
  "difficulty": 2
}
```

### Security — what-if
```json
{
  "context": "After login, the server stores the session id in a cookie the browser sends with every request. Flags on that cookie decide who can read it.",
  "question": "What would an attacker gain if we removed the `httpOnly` flag from the session cookie?",
  "options": ["Nothing, it's cosmetic", "XSS scripts could read and steal the session token", "They could bypass HTTPS", "The cookie would expire sooner"],
  "answer": 1,
  "explanation": "httpOnly hides the cookie from document.cookie, so injected JS can't exfiltrate it. It doesn't affect HTTPS (that's `secure`).",
  "concept": "Cookie security flags",
  "files": ["server/auth.ts"],
  "difficulty": 2
}
```

### Architecture — flow
```json
{
  "context": "Checkout uses Stripe: our server creates a PaymentIntent, the browser confirms it with Stripe, and Stripe calls our webhook when the charge settles.",
  "question": "A user clicks 'Pay'. Which runs FIRST?",
  "options": ["The webhook handler", "createPaymentIntent() on our server", "The success redirect", "The DB order insert"],
  "answer": 1,
  "explanation": "The client needs a PaymentIntent secret from our server before Stripe can charge; the webhook fires only after Stripe confirms.",
  "concept": "Payment flow",
  "files": ["server/payments.ts", "web/Checkout.tsx"],
  "difficulty": 3
}
```

### Language feature — technique
```json
{
  "context": "The product editor uploads all selected images in parallel, then shows which ones succeeded and which failed.",
  "question": "Why `Promise.allSettled` instead of `Promise.all` for the image uploads?",
  "options": ["It's faster", "One failed upload shouldn't cancel reporting the others", "It retries failures", "all() doesn't work with arrays"],
  "answer": 1,
  "explanation": "all() rejects on the first failure and you lose the other results; allSettled() waits for every promise and reports each outcome.",
  "concept": "Promise combinators",
  "files": ["src/upload.ts:30"],
  "difficulty": 2
}
```

## Difficulty guide

- **1** — what the code does / direct consequence of the change.
- **2** — why this approach, or what happens on an edge case.
- **3** — trade-offs, interactions between files, failure modes, security/perf implications.
