# Contributing

Thanks for contributing to `dsh-workspace-mover`.

## Development

Requirements:

- Node.js 22 or newer
- DeepSeek Harness for manual integration testing

Run the test suite:

```bash
npm test
```

The project is dependency-free and has no build step. Keep changes focused, preserve existing DSH integration patterns, and add tests for behavior changes.

## Pull Requests

- Describe the user-visible behavior and failure cases covered.
- Update `CHANGELOG.md` for user-visible changes.
- Run `npm test` and include the result.
- Do not include personal DSH data, session archives, or backup files.
