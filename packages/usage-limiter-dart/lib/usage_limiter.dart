library usage_limiter;

enum UsageMetricId {
  database,
  projects,
  compute,
  egress,
  fileStorage,
  monthlyActiveUsers,
  monthlyActiveThirdPartyUsers,
  realtimeConnections,
  realtimeMessages,
  edgeInvocations,
  branches,
  functionInvocations,
  functionActiveCapacity,
  functionWaitingCapacity,
}

enum LimitScope { project, organization, account }

enum LimitPeriod { month, concurrent, fixed, unknown }

enum FeatureAvailability { included, notIncluded, conditional, external }

enum ProjectLifecycleState { active, degraded, idle, paused, unknown }

enum UsageProvider { supabase, neon }

const warningThresholds = <int>[50, 70, 90];
const hardStopThreshold = 90;

class ProviderLifecycleProfile {
  const ProviderLifecycleProfile({
    required this.idleAfter,
    required this.idleBehavior,
    required this.wakeBehavior,
    required this.applicationImpact,
    required this.recovery,
  });

  final String idleAfter;
  final String idleBehavior;
  final String wakeBehavior;
  final String applicationImpact;
  final String recovery;
}

const providerLifecycle = <UsageProvider, ProviderLifecycleProfile>{
  UsageProvider.supabase: ProviderLifecycleProfile(
    idleAfter: 'Approximately 7 days of low database activity',
    idleBehavior: 'The entire free project may be paused.',
    wakeBehavior: 'A request does not automatically resume the project.',
    applicationImpact:
        'Database APIs and Auth that depend on the project may be unavailable.',
    recovery:
        'Manually resume in the Supabase dashboard; restore is available for up to 1 year.',
  ),
  UsageProvider.neon: ProviderLifecycleProfile(
    idleAfter: '5 minutes without active queries',
    idleBehavior:
        'Only the stateless PostgreSQL compute goes idle; stored data remains.',
    wakeBehavior:
        'A new connection automatically activates compute, usually in a few hundred milliseconds.',
    applicationImpact:
        'The first database-dependent request may be slower; session-scoped state is lost on suspend.',
    recovery:
        'Retry a safe connection/startup attempt with bounded backoff; do not ping to keep compute awake.',
  ),
};

class ProjectLifecycle {
  const ProjectLifecycle({
    required this.provider,
    required this.projectId,
    required this.projectName,
    required this.state,
    required this.status,
    required this.message,
    this.resumeUrl,
  });

  final UsageProvider provider;
  final String projectId;
  final String projectName;
  final ProjectLifecycleState state;
  final String status;
  final String message;
  final String? resumeUrl;
}

ProjectLifecycle supabaseProjectLifecycle({
  required String projectId,
  required String projectName,
  required String status,
}) {
  final normalizedStatus = status.toUpperCase();
  final state = switch (normalizedStatus) {
    'ACTIVE_HEALTHY' => ProjectLifecycleState.active,
    'ACTIVE_UNHEALTHY' => ProjectLifecycleState.degraded,
    'INACTIVE' || 'PAUSED' => ProjectLifecycleState.paused,
    _ => ProjectLifecycleState.unknown,
  };

  return ProjectLifecycle(
    provider: UsageProvider.supabase,
    projectId: projectId,
    projectName: projectName,
    state: state,
    status: normalizedStatus,
    message: state == ProjectLifecycleState.paused
        ? 'Project is paused. Resume it manually in the Supabase dashboard.'
        : state == ProjectLifecycleState.active
            ? 'Project is active.'
            : state == ProjectLifecycleState.degraded
                ? 'Project is active but unhealthy; availability is not confirmed.'
                : 'Project status is $normalizedStatus; availability is not confirmed.',
    resumeUrl: state == ProjectLifecycleState.paused
        ? 'https://supabase.com/dashboard/project/$projectId'
        : null,
  );
}

class SupabaseProjectPausedException implements Exception {
  const SupabaseProjectPausedException(this.project);

  final ProjectLifecycle project;

  @override
  String toString() =>
      'Supabase project "${project.projectName}" is paused. Resume it manually '
      'in the Supabase dashboard.';
}

void assertSupabaseProjectReady(ProjectLifecycle project) {
  if (project.provider == UsageProvider.supabase &&
      project.state == ProjectLifecycleState.paused) {
    throw SupabaseProjectPausedException(project);
  }
  if (project.provider == UsageProvider.supabase &&
      project.state != ProjectLifecycleState.active) {
    throw SupabaseProjectNotReadyException(project);
  }
}

class SupabaseProjectNotReadyException implements Exception {
  const SupabaseProjectNotReadyException(this.project);

  final ProjectLifecycle project;

  @override
  String toString() =>
      'Supabase project "${project.projectName}" is not confirmed ready '
      '(status: ${project.status}).';
}

class NeonWakeException implements Exception {
  const NeonWakeException(this.message);

  final String message;

  @override
  String toString() => message;
}

bool isNeonWakeRetryable(Object error) {
  if (error is NeonWakeException) return true;
  return RegExp(
    r'57P03|cannot connect now|compute (is )?(waking|starting|idle)|'
    r'endpoint (is )?(suspended|starting)|database system is starting up',
    caseSensitive: false,
  ).hasMatch(error.toString());
}

Future<T> withNeonWakeRetry<T>(
  Future<T> Function() operation, {
  int maxRetries = 3,
  Duration initialDelay = const Duration(milliseconds: 200),
  Duration maxDelay = const Duration(seconds: 1),
  bool Function(Object error)? retryWhen,
  Future<void> Function(Duration delay)? wait,
}) async {
  if (maxRetries < 0) {
    throw ArgumentError.value(
        maxRetries, 'maxRetries', 'Must not be negative.');
  }
  if (initialDelay.isNegative || maxDelay.isNegative) {
    throw ArgumentError('Retry delays must not be negative.');
  }

  final shouldRetry = retryWhen ?? isNeonWakeRetryable;
  final sleep = wait ?? Future<void>.delayed;

  for (var attempt = 0;; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetry(error)) rethrow;
      final multiplier = 1 << attempt;
      final delayMs = initialDelay.inMilliseconds * multiplier;
      await sleep(
        Duration(milliseconds: delayMs.clamp(0, maxDelay.inMilliseconds)),
      );
    }
  }
}

class MetricLimit {
  const MetricLimit({
    required this.id,
    required this.label,
    required this.limit,
    required this.unit,
    this.scope = LimitScope.project,
    this.period = LimitPeriod.month,
  });

  final UsageMetricId id;
  final String label;
  final double? limit;
  final String unit;
  final LimitScope scope;
  final LimitPeriod period;
}

class UsageMetric extends MetricLimit {
  const UsageMetric({
    required super.id,
    required super.label,
    required super.limit,
    required super.unit,
    super.scope = LimitScope.project,
    super.period = LimitPeriod.month,
    required this.usage,
    required this.available,
    this.unavailableReason,
    this.scopeId,
  });

  final double? usage;
  final bool available;
  final String? unavailableReason;
  final String? scopeId;
}

class UsageWarning {
  const UsageWarning({
    required this.metric,
    required this.percent,
    required this.threshold,
    this.scopeId,
  });

  final UsageMetric metric;
  final double percent;
  final int threshold;
  final String? scopeId;
}

class FeatureSupport {
  const FeatureSupport({
    required this.id,
    required this.label,
    required this.availability,
    required this.details,
  });

  final String id;
  final String label;
  final FeatureAvailability availability;
  final String details;
}

class UsageLimitReachedException implements Exception {
  const UsageLimitReachedException(this.warning);

  final UsageWarning warning;

  @override
  String toString() =>
      '${warning.metric.label} reached the $hardStopThreshold% hard-stop '
      'threshold; operation blocked.';
}

const freeLimits = <UsageProvider, List<MetricLimit>>{
  UsageProvider.supabase: [
    MetricLimit(
      id: UsageMetricId.database,
      label: 'Database',
      limit: 500,
      unit: 'MB',
      scope: LimitScope.project,
      period: LimitPeriod.fixed,
    ),
    MetricLimit(
      id: UsageMetricId.projects,
      label: 'Projects',
      limit: 2,
      unit: 'projects',
      scope: LimitScope.account,
      period: LimitPeriod.fixed,
    ),
    MetricLimit(
      id: UsageMetricId.compute,
      label: 'Compute memory',
      limit: 500,
      unit: 'MB RAM',
      scope: LimitScope.project,
      period: LimitPeriod.fixed,
    ),
    MetricLimit(
      id: UsageMetricId.egress,
      label: 'Egress bandwidth',
      limit: 5,
      unit: 'GB',
      scope: LimitScope.organization,
      period: LimitPeriod.month,
    ),
    MetricLimit(
      id: UsageMetricId.fileStorage,
      label: 'File storage',
      limit: 1,
      unit: 'GB',
      scope: LimitScope.organization,
      period: LimitPeriod.fixed,
    ),
    MetricLimit(
      id: UsageMetricId.monthlyActiveUsers,
      label: 'Monthly active users',
      limit: 50000,
      unit: 'MAU',
      scope: LimitScope.organization,
      period: LimitPeriod.month,
    ),
    MetricLimit(
      id: UsageMetricId.monthlyActiveThirdPartyUsers,
      label: 'Monthly active third-party users',
      limit: 50000,
      unit: 'MAU',
      scope: LimitScope.organization,
      period: LimitPeriod.month,
    ),
    MetricLimit(
      id: UsageMetricId.realtimeConnections,
      label: 'Realtime concurrent connections',
      limit: 200,
      unit: 'connections',
      scope: LimitScope.project,
      period: LimitPeriod.concurrent,
    ),
    MetricLimit(
      id: UsageMetricId.realtimeMessages,
      label: 'Realtime messages',
      limit: 2000000,
      unit: 'messages',
      scope: LimitScope.organization,
      period: LimitPeriod.month,
    ),
    MetricLimit(
      id: UsageMetricId.edgeInvocations,
      label: 'Edge Function invocations',
      limit: 500000,
      unit: 'invocations',
      scope: LimitScope.organization,
      period: LimitPeriod.month,
    ),
    MetricLimit(
      id: UsageMetricId.branches,
      label: 'Database branches',
      limit: null,
      unit: 'branches',
      scope: LimitScope.project,
      period: LimitPeriod.unknown,
    ),
  ],
  UsageProvider.neon: [
    MetricLimit(
      id: UsageMetricId.database,
      label: 'Database',
      limit: 1,
      unit: 'GB',
      scope: LimitScope.project,
      period: LimitPeriod.fixed,
    ),
    MetricLimit(
      id: UsageMetricId.projects,
      label: 'Projects',
      limit: 100,
      unit: 'projects',
      scope: LimitScope.account,
      period: LimitPeriod.fixed,
    ),
    MetricLimit(
      id: UsageMetricId.compute,
      label: 'Compute',
      limit: 100,
      unit: 'CU-hours',
      scope: LimitScope.project,
      period: LimitPeriod.month,
    ),
    MetricLimit(
      id: UsageMetricId.egress,
      label: 'Egress bandwidth',
      limit: 5,
      unit: 'GB',
      scope: LimitScope.project,
      period: LimitPeriod.month,
    ),
    MetricLimit(
      id: UsageMetricId.fileStorage,
      label: 'Object storage',
      limit: 5,
      unit: 'GB',
      scope: LimitScope.project,
      period: LimitPeriod.fixed,
    ),
    MetricLimit(
      id: UsageMetricId.monthlyActiveUsers,
      label: 'Better Auth monthly active users',
      limit: 60000,
      unit: 'MAU',
      scope: LimitScope.project,
      period: LimitPeriod.month,
    ),
    MetricLimit(
      id: UsageMetricId.branches,
      label: 'Database branches',
      limit: 10,
      unit: 'branches',
      scope: LimitScope.project,
      period: LimitPeriod.fixed,
    ),
    MetricLimit(
      id: UsageMetricId.functionInvocations,
      label: 'Node.js Function invocations',
      limit: 1000000,
      unit: 'invocations',
      scope: LimitScope.project,
      period: LimitPeriod.month,
    ),
    MetricLimit(
      id: UsageMetricId.functionActiveCapacity,
      label: 'Node.js Functions active capacity',
      limit: 10,
      unit: 'capacity-hours',
      scope: LimitScope.project,
      period: LimitPeriod.month,
    ),
    MetricLimit(
      id: UsageMetricId.functionWaitingCapacity,
      label: 'Node.js Functions waiting capacity',
      limit: 400,
      unit: 'capacity-hours',
      scope: LimitScope.project,
      period: LimitPeriod.month,
    ),
  ],
};

const freeFeatures = <UsageProvider, List<FeatureSupport>>{
  UsageProvider.supabase: [
    FeatureSupport(
      id: 'postgresql',
      label: 'PostgreSQL',
      availability: FeatureAvailability.included,
      details: 'Managed PostgreSQL database.',
    ),
    FeatureSupport(
      id: 'auth',
      label: 'Email/password, OAuth, magic link, OTP, and user management',
      availability: FeatureAvailability.included,
      details: 'Supabase Auth.',
    ),
    FeatureSupport(
      id: 'realtime',
      label: 'Realtime changes, Broadcast, and Presence',
      availability: FeatureAvailability.included,
      details: 'Realtime limits are also listed in freeLimits.',
    ),
    FeatureSupport(
      id: 'rest',
      label: 'Automatic REST API',
      availability: FeatureAvailability.included,
      details: 'Generated from the database schema.',
    ),
    FeatureSupport(
      id: 'functions',
      label: 'Server-side functions',
      availability: FeatureAvailability.included,
      details: 'Edge Functions; invocation quota is listed in freeLimits.',
    ),
    FeatureSupport(
      id: 'branches',
      label: 'Database branching',
      availability: FeatureAvailability.conditional,
      details: 'Availability and limits depend on current plan terms.',
    ),
    FeatureSupport(
      id: 'logs',
      label: 'Logs and monitoring',
      availability: FeatureAvailability.included,
      details: 'Retention and available detail vary by plan.',
    ),
    FeatureSupport(
      id: 'instantRestore',
      label: 'Instant restore',
      availability: FeatureAvailability.notIncluded,
      details: 'Free plan does not include paid-plan point-in-time recovery.',
    ),
  ],
  UsageProvider.neon: [
    FeatureSupport(
      id: 'postgresql',
      label: 'PostgreSQL',
      availability: FeatureAvailability.included,
      details: 'Serverless PostgreSQL.',
    ),
    FeatureSupport(
      id: 'auth',
      label: 'Email/password, OAuth, magic link, OTP, and user management',
      availability: FeatureAvailability.included,
      details:
          'Better Auth integration; included MAU allowance is in freeLimits.',
    ),
    FeatureSupport(
      id: 'realtime',
      label: 'Database Realtime, Broadcast, and Presence',
      availability: FeatureAvailability.external,
      details: 'Use a separate realtime solution.',
    ),
    FeatureSupport(
      id: 'rest',
      label: 'REST API',
      availability: FeatureAvailability.conditional,
      details: 'PostgREST-compatible options exist; no built-in generated API.',
    ),
    FeatureSupport(
      id: 'functions',
      label: 'Server-side functions',
      availability: FeatureAvailability.included,
      details: 'Node.js Functions; quotas are listed in freeLimits.',
    ),
    FeatureSupport(
      id: 'branches',
      label: 'Database branching',
      availability: FeatureAvailability.included,
      details: '10 branches per project.',
    ),
    FeatureSupport(
      id: 'logs',
      label: 'Logs and monitoring',
      availability: FeatureAvailability.included,
      details: 'Retention and available detail vary by plan.',
    ),
    FeatureSupport(
      id: 'instantRestore',
      label: 'Instant restore',
      availability: FeatureAvailability.included,
      details: '6-hour restore window.',
    ),
  ],
};

double? usagePercent(UsageMetric metric) {
  final usage = metric.usage;
  final limit = metric.limit;
  if (!metric.available ||
      usage == null ||
      !usage.isFinite ||
      limit == null ||
      !limit.isFinite ||
      limit <= 0) {
    return null;
  }
  return (usage / limit * 100).clamp(0, double.infinity).toDouble();
}

int? warningThresholdFor(double percent) {
  if (!percent.isFinite) return null;
  for (final threshold in warningThresholds.reversed) {
    if (percent >= threshold) return threshold;
  }
  return null;
}

UsageWarning? evaluateUsage(UsageMetric metric) {
  final percent = usagePercent(metric);
  if (percent == null) return null;
  final threshold = warningThresholdFor(percent);
  if (threshold == null) return null;
  return UsageWarning(
    metric: metric,
    percent: percent,
    threshold: threshold,
    scopeId: metric.scopeId,
  );
}

void assertUsageAllowed(UsageMetric metric) {
  final warning = evaluateUsage(metric);
  if (warning != null && warning.percent >= hardStopThreshold) {
    throw UsageLimitReachedException(warning);
  }
}

Future<T> withUsageGuard<T>(
  UsageMetric metric,
  Future<T> Function() operation,
) async {
  assertUsageAllowed(metric);
  return operation();
}

List<int> crossedThresholds(double previousPercent, double currentPercent) {
  if (!previousPercent.isFinite || !currentPercent.isFinite) return [];
  return warningThresholds
      .where(
        (threshold) =>
            previousPercent < threshold && currentPercent >= threshold,
      )
      .toList(growable: false);
}
