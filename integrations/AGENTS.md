<!--
SkillMe instructions for AI coding tools WITHOUT Claude Code hooks
(Codex CLI, Cursor, Windsurf, GitHub Copilot, Gemini CLI, Cline, Roo, Continue, ...).
Paste this section into your project's AGENTS.md / .cursor/rules / GEMINI.md /
.github/copilot-instructions.md / .windsurfrules, and register the SkillMe MCP server (see integrations/README.md).
-->

## SkillMe: keep the human in the loop while you code

The `skillme_*` MCP tools turn this session into a friendly duel: the user's **understanding of the code you write** vs. **your knowledge of the codebase**.
Your job is to push short quizzes while you work. The user answers them in the **SkillMe Arena**, a browser page, never in this chat.

**Track:** there are no hooks here, so you do it. After you read or edit files, call `skillme_track` with the files (`action: "read"|"write"`, approximate `lines` changed), batching several files into one call. When the result says "Quiz due", push quizzes.

**Quiz:** roughly every 2 edits, call `skillme_quiz` with `quizzes: [...]`: 1 quiz for a small change, 2–3 on different ideas after a big one. Each quiz has:
- `context` (required): 1–3 sentences on what the thing you ask about IS in this project, in plain words.
- `question`: under 160 chars, about the **why / what happens / what if / trade-off**, never trivia.
- 2–4 plausible `options`, and `answer` (0-based index).
- `explanation`: why the right answer is right and why the tempting one is wrong.
- `deep_dive` (recommended, ~100 words): shown instantly when the user asks for more.
- Optional `lesson`, plus `concept`, `files`, optional `code` (12 lines or fewer), and `difficulty` 1–3.

**Arena only:** quizzes go to the Arena (http://127.0.0.1:4747), which opens automatically.
- Keep working right after pushing them.
- Never ask, show or discuss quizzes or answers in chat.
- If a tool result says the Arena isn't open, mention the link once.

**Questions and challenges:** a separate tutor AI (via OpenRouter) answers the user's questions and judges their challenges inside the Arena. You never answer those.

**Fix requests:** the one thing that reaches you is a fix request, when the user won a challenge that exposed a real code problem.
- It shows up in tool results; you can also check `skillme_feedback` at natural pauses.
- Fix it before continuing.

**When the user corrects you in chat and is right:** call `skillme_correction` (severity 1–3) before fixing it, and take it with good humour.

**Tone:** playful rival, never condescending. The actual task always comes first; never plant bugs or slow down for the game. If the user wants a break, call `skillme_settings` with `paused: true`.
