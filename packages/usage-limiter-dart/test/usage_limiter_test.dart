import 'package:usage_limiter/usage_limiter.dart';

Future<void> main() async {
  final limit = freeLimits[UsageProvider.neon]!.first;
  final warning = evaluateUsage(
    UsageMetric(
      id: limit.id,
      label: limit.label,
      limit: limit.limit,
      unit: limit.unit,
      usage: 0.9,
      available: true,
    ),
  );
  assert(warning?.threshold == 90);
  assert(warning?.percent == 90);
  assert(crossedThresholds(45, 95).join(',') == '50,70,90');
  assert(
    evaluateUsage(
          UsageMetric(
            id: limit.id,
            label: limit.label,
            limit: limit.limit,
            unit: limit.unit,
            usage: null,
            available: false,
          ),
        ) ==
        null,
  );

  var operationStarted = false;
  final hardStop = UsageMetric(
    id: limit.id,
    label: limit.label,
    limit: limit.limit,
    unit: limit.unit,
    usage: limit.limit! * 0.9,
    available: true,
    scope: limit.scope,
    period: limit.period,
  );
  try {
    await withUsageGuard(hardStop, () async {
      operationStarted = true;
    });
  } on UsageLimitReachedException {
    // Expected: the guarded operation must not start.
  }
  assert(!operationStarted);

  final belowHardStop = UsageMetric(
    id: limit.id,
    label: limit.label,
    limit: limit.limit,
    unit: limit.unit,
    usage: limit.limit! * 0.89,
    available: true,
    scope: limit.scope,
    period: limit.period,
  );
  assertUsageAllowed(belowHardStop);
  final result = await withUsageGuard(belowHardStop, () async => 'allowed');
  assert(result == 'allowed');
  assert(
    freeLimits[UsageProvider.supabase]!
            .firstWhere((item) => item.id == UsageMetricId.monthlyActiveUsers)
            .limit ==
        50000,
  );

  final pausedProject = supabaseProjectLifecycle(
    projectId: 'paused-ref',
    projectName: 'Paused project',
    status: 'INACTIVE',
  );
  assert(pausedProject.state == ProjectLifecycleState.paused);
  assert(pausedProject.resumeUrl!.contains('paused-ref'));
  try {
    assertSupabaseProjectReady(pausedProject);
    throw StateError('Expected paused Supabase project to require resume.');
  } on SupabaseProjectPausedException {
    // Expected: Supabase does not automatically resume on an app request.
  }
  try {
    assertSupabaseProjectReady(
      supabaseProjectLifecycle(
        projectId: 'unknown-ref',
        projectName: 'Unknown project',
        status: 'UNKNOWN',
      ),
    );
    throw StateError('Expected unknown project status to fail closed.');
  } on SupabaseProjectNotReadyException {
    // Expected: an unknown status is not assumed to be ready.
  }

  var wakeAttempts = 0;
  final delays = <Duration>[];
  final connected = await withNeonWakeRetry(
    () async {
      wakeAttempts += 1;
      if (wakeAttempts < 3) throw const NeonWakeException('compute is waking');
      return 'connected';
    },
    initialDelay: const Duration(milliseconds: 100),
    wait: (delay) async {
      delays.add(delay);
    },
  );
  assert(connected == 'connected');
  assert(wakeAttempts == 3);
  assert(delays.length == 2);
  assert(delays[0] == const Duration(milliseconds: 100));
  assert(delays[1] == const Duration(milliseconds: 200));
  assert(
      providerLifecycle[UsageProvider.neon]!.idleAfter.contains('5 minutes'));
}
