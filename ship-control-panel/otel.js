// Azure Monitor OpenTelemetry bootstrap (logs/traces/metrics)
// Loaded via: node -r ./otel.js server.js

try {
  const { useAzureMonitor } = require('@azure/monitor-opentelemetry');

  // Only enable when connection string is present.
  if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
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
  }
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('otel bootstrap failed', e);
}
