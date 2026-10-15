library usage_limiter_flutter;

import 'package:flutter/material.dart';
import 'package:usage_limiter/usage_limiter.dart';

class UsageWarningBanner extends StatelessWidget {
  const UsageWarningBanner({
    required this.metric,
    super.key,
  });

  final UsageMetric metric;

  @override
  Widget build(BuildContext context) {
    final warning = evaluateUsage(metric);
    if (warning == null) return const SizedBox.shrink();

    return Card(
      child: ListTile(
        leading: const Icon(Icons.warning_amber_rounded),
        title: Text(
          '${metric.label} usage reached ${warning.threshold}% '
          '(${metric.usage} / ${metric.limit} ${metric.unit}).',
        ),
      ),
    );
  }
}
