---
name: commit-to-github
description: Generate a Chinese changelog entry, create a Chinese conventional commit, and push project changes to GitHub. Use when the user says “提交到github”, “提交到 GitHub”, “生成 commit msg/changelog 并提交”, or asks Codex to commit and push the current project changes.
---

# Commit To GitHub

## Workflow

1. Inspect the workspace:
   - Run `git status --short --branch`.
   - Review changed and untracked files with `git diff --stat`, `git diff --name-only`, and `git ls-files --others --exclude-standard`.
   - Do not revert unrelated user changes.

2. Summarize the change:
   - Read relevant diffs before writing the changelog.
   - Generate a Chinese `CHANGELOG.md` entry under today’s date.
   - Use concise bullets grouped around user-visible behavior, backend behavior, tests, and tooling when relevant.

3. Validate before committing:
   - Run the repository’s normal checks, usually `npm run check` and `npm test`.
   - If validation fails, fix the issue and rerun validation before committing.
   - If validation cannot be run, state the reason and do not hide it.

4. Commit:
   - Use a Chinese conventional commit message.
   - Prefer `feat:` for user-visible product improvements, `fix:` for bug fixes, `chore:` for workflow/tooling-only changes.
   - Include a short subject and a Chinese body describing core changes and validation.

5. Push:
   - Push the current branch to `origin`.
   - After successful `git add`, `git commit`, and `git push`, emit the required Codex git directives in the final response.

## Commit Message Format

Use this shape:

```text
feat: 优化 AI 全站匹配与达人结果质量

- 增强候选召回、资料补全和质量过滤
- 增加通用基础特征约束校验，提升结果精准度
- 优化前端流式展示体验和状态反馈
- 补充相关单元测试并通过验证
```

Adjust the subject and bullets to match the actual diff.
