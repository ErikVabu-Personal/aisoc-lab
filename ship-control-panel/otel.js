// Azure Monitor OpenTelemetry bootstrap (logs/traces/metrics)
// Loaded via: node -r ./otel.js server.js

// In Next.js standalone output, node_modules is bundled only for the app runtime.
// Preloading this file happens very early, so make OTEL strictly best-effort:
// if the dependency isn't present, don't crash or spam noisy stack traces.

if (!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  // nothing to do
} else {
  try {
    const { useAzureMonitor } = require('@azure/monitor-opentelemetry');

    useAzureMonitor({
      azureMonitorExporterOptions: {
        connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
      },
    });

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        service: process.env.OTEL_SERVICE_NAME || 'ship-control-panel',
        event: 'otel.enabled',
      }),
    );
  } catch (e) {
    const code = (e && typeof e === 'object' && 'code' in e ? (e as any).code : undefined) ?? undefined;
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        time: new Date().toISOString(),
        service: process.env.OTEL_SERVICE_NAME || 'ship-control-panel',
        event: 'otel.disabled',
        reason: code === 'MODULE_NOT_FOUND' ? 'module_not_found' : 'bootstrap_failed',
      }),
    );
  }
}
