# Contributing

Contributions should start with a focused GitHub Issue and preserve the
responsibility boundaries documented in [the architecture](docs/architecture.md).

## Workflow

1. Create or select a GitHub Issue using the work-item template.
2. Create a branch from `origin/main`, preferably including the issue number.
3. Make the smallest coherent change that satisfies the issue.
4. Update tests and documentation with the implementation.
5. Run `just check-all` in the Dev Container.
6. Open a draft pull request that links the issue and includes validation
   evidence.

## Compatibility

The project is pre-1.0, but format changes still require explicit review.
Changes to archive entries, manifest serialization, SQLite handling, CLI
output, or the C ABI must describe their compatibility impact and update the
appropriate documentation and fixtures.

## Commit and pull request guidance

Use concise, imperative commit messages. A component prefix is welcome when it
adds clarity, for example:

```text
[tmd-core] Validate attachment paths during reads
[tmd-vscode] Add document validation command
[docs] Clarify the container contract
```

Pull requests should explain what changed, why it changed, user or developer
impact, and the exact checks that passed.

## Publishing

Do not publish crates, the VS Code extension, releases, or tags as part of a
normal contribution. See [publish readiness](docs/publish-readiness.md).
