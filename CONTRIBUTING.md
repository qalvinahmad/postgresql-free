# Contributing

Thanks for considering a contribution.

## Before opening a pull request

1. Keep changes scoped to the requested behavior.
2. Add or update tests for changed thresholds, lifecycle states, and provider
   response mappings.
3. Update the README or relevant guide when public behavior or configuration
   changes.
4. Never add provider API tokens, database credentials, or production
   snapshots to the repository.

## Local checks

```sh
npm install
npm test
npm run typecheck

cd packages/usage-limiter-dart
dart pub get
dart analyze
dart run --enable-asserts test/usage_limiter_test.dart

cd ../usage-limiter-flutter
flutter pub get
flutter analyze
```

## Provider data changes

- Prefer official provider documentation and API schemas.
- Include source links and the date reviewed.
- Preserve raw provider status when normalizing lifecycle state.
- Do not map a missing metric to zero or to an assumed healthy state.
- Document metric scope, units, period, and any conversion.
- Avoid retrying non-idempotent work automatically.

## Pull requests

Describe the user-visible change, affected packages, validation run, and any
provider assumptions. Keep credentials and personal information out of
screenshots, logs, fixtures, and PR descriptions.
