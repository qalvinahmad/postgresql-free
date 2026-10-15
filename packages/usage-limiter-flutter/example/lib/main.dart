import 'package:flutter/material.dart';
import 'package:usage_limiter/usage_limiter.dart';
import 'package:usage_limiter_flutter/usage_limiter_flutter.dart';

void main() => runApp(const UsageLimiterExampleApp());

class UsageLimiterExampleApp extends StatelessWidget {
  const UsageLimiterExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    final limit = freeLimits[UsageProvider.neon]!
        .firstWhere((item) => item.id == UsageMetricId.egress);
    final sample = UsageMetric(
      id: limit.id,
      label: limit.label,
      limit: limit.limit,
      unit: limit.unit,
      scope: limit.scope,
      period: limit.period,
      usage: 4.6,
      available: true,
      scopeId: 'demo-project',
    );

    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Usage warnings')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text(
              'Demo data only. Replace this sample with a fresh server snapshot.',
            ),
            const SizedBox(height: 16),
            UsageWarningBanner(metric: sample),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () async {
                try {
                  await withUsageGuard(sample, () async {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Operation allowed')),
                    );
                  });
                } on UsageLimitReachedException catch (error) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(error.toString())),
                  );
                }
              },
              child: const Text('Run guarded operation'),
            ),
          ],
        ),
      ),
    );
  }
}
