# E2E fixtures

These files are rendered by the Playwright E2E suite through the real GitHub UI
(`https://github.com/champierre/gitifact/blob/main/test/fixtures/...`). They must be pushed to GitHub
for those tests to run; tests skip themselves when the fixture is not reachable.

For the "branch name contains `/`" case, push the same tree to a branch named `e2e/slash-branch`:

    git push origin main:e2e/slash-branch
