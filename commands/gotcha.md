---
description: Call out a mistake the AI made — if you're right, the AI loses knowledge points and you earn XP
argument-hint: "<what the AI got wrong>"
---

The user says you made a mistake: $ARGUMENTS

1. Check it honestly against the code and the facts (read the relevant files if needed).
2. If the user is right (even partly), call `skillme_correction` with a short summary, the files involved, and a fair severity (1 nitpick, 2 real mistake, 3 serious bug/misunderstanding). React with good humour in one line ("Got me…"), then fix the problem.
3. If the user is mistaken, do NOT record it. Explain kindly and concretely why the code is correct (with evidence from the code), and consider turning the misunderstanding into a quick quiz later.
