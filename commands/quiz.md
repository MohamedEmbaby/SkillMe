---
description: Send me fresh quizzes about the recent changes (or a topic / file you name) in the Arena
argument-hint: "[topic, file, or number of questions]"
---

The user wants new quizzes right now. Topic / scope: $ARGUMENTS
If that's empty, use the code you changed most recently in this session. If nothing has changed yet, use the most important part of the codebase you have read.

1. Call `skillme_status` to get `suggested_difficulty` and the weak concepts.
2. Push 2–3 quizzes in one `skillme_quiz` call (more only if the user asked), following the skillme skill's rules:
   - each starts with a `context` saying what the thing is;
   - short questions about the why / what happens;
   - a teaching `explanation` and a `deep_dive`.
3. Then call `skillme_status` with `open: true` and reply in one line that the quizzes are waiting in the Arena.
   Don't ask them, show them or hint at the answers in chat: the user answers only in the Arena.
