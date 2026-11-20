# Using SkillMe with other AI coding tools

SkillMe's engine is a plain **MCP server** (`server/index.js`, Node ≥ 18, no `npm install` needed), so any MCP-capable assistant can play.
Without Claude Code's hooks, the AI reports its own file activity with `skillme_track`, which the instructions in [AGENTS.md](AGENTS.md) tell it to do.

First, clone the repo anywhere: `git clone https://github.com/MohamedEmbaby/SkillMe`. In the configs below, replace `/path/to/SkillMe` with the real path of your clone (on Windows, forward slashes work: `C:/tools/SkillMe`).

Then two steps for every tool:

1. **Register the MCP server.** Use the absolute path to `server/index.js` in your clone: `/path/to/SkillMe/server/index.js`.
2. **Add the instructions.** Paste [AGENTS.md](AGENTS.md) into the file your tool reads. If your tool supports Agent Skills (`SKILL.md`), you can load [`skills/skillme`](../skills/skillme/SKILL.md) instead.

> The server detects the project from its working directory (nearest `.git`). If your tool starts MCP servers somewhere else, add `"env": { "SKILLME_PROJECT": "/path/to/project" }`. The AI can also pass `project` on any tool call.

Quizzes are answered only in the Arena at **http://127.0.0.1:4747**, never in the chat. It opens automatically when quizzes arrive.

---

## Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):
```json
{
  "mcpServers": {
    "skillme": { "command": "node", "args": ["/path/to/SkillMe/server/index.js"] }
  }
}
```
Instructions: copy [`cursor/skillme.mdc`](cursor/skillme.mdc) to `.cursor/rules/skillme.mdc`, or paste AGENTS.md into the project's `AGENTS.md`.

## VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json`:
```json
{
  "servers": {
    "skillme": { "type": "stdio", "command": "node", "args": ["/path/to/SkillMe/server/index.js"] }
  }
}
```
Instructions: paste AGENTS.md into `.github/copilot-instructions.md`.

## OpenAI Codex CLI

`~/.codex/config.toml`:
```toml
[mcp_servers.skillme]
command = "node"
args = ["/path/to/SkillMe/server/index.js"]
```
Instructions: paste AGENTS.md into the project's `AGENTS.md`.

## Gemini CLI

`~/.gemini/settings.json` (or `.gemini/settings.json` in the project):
```json
{
  "mcpServers": {
    "skillme": { "command": "node", "args": ["/path/to/SkillMe/server/index.js"] }
  }
}
```
Instructions: paste AGENTS.md into `GEMINI.md`.

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "skillme": { "command": "node", "args": ["/path/to/SkillMe/server/index.js"] }
  }
}
```
Instructions: paste AGENTS.md into `.windsurfrules` (or a Windsurf rule).

## Cline / Roo Code / Continue / Zed

Add an MCP server with command `node` and args `["/path/to/SkillMe/server/index.js"]` in the tool's MCP settings, then paste AGENTS.md into its custom instructions or rules file.

## Claude Desktop / claude.ai

- **Claude Desktop:** add the same `mcpServers` entry to `claude_desktop_config.json`, and set `SKILLME_PROJECT` in `env`, because Desktop isn't tied to a project folder.
- **claude.ai:** not supported. SkillMe needs its tools and the Arena, and nothing is answered in the chat.

## Arena only (no AI integration)

`npm run arena` (or `node server/index.js --arena --open`) serves the Arena on its own, for example to review quiz history.
