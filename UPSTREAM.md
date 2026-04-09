# Upstream Source

- **Source:** microsoft/playwright @ commit `ef45dd4be704a2f161c63fcf0dedbf2b6913d823`
- **Version:** 1.59.0-alpha-1773608981000
- **Date:** 2026-04-10
- **Files:** `packages/playwright-core/src/` → `src/`
- **Third-party:** `packages/playwright-core/bundles/*/src/third_party/` → `src/third_party/`

## Sync Procedure

1. Clone upstream at a newer commit
2. Diff `packages/playwright-core/src/tools/` against our `src/tools/`
3. Apply upstream changes selectively (avoid overwriting Earthling modifications)
4. Update this file with the new commit hash and date
