# AGENTS.md

Instructions for AI coding agents maintaining or extending pi-skill-guard.

## Project Overview

pi-skill-guard is a pi extension that intercepts "tool not found" errors and:
- If the tool name matches a skill → returns the skill's SKILL.md content
- If the tool name doesn't match a skill but has a "command" argument → executes the command via bash

## Development

### Setup
```bash
pnpm install
```

### Type Check
```bash
npx tsc --noEmit
```

### Release Process
1. Bump version in `package.json`
2. Commit with message: `release: v0.1.2`
3. Create git tag: `v0.1.2`
4. Publish to npm: `pnpm publish`

### Code Conventions
- TypeScript with strict mode enabled
- Use `const` over `let`
- Prefer immutable patterns (no mutation)
- No ESLint/Prettier currently configured