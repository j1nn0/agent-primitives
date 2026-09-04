import { resolve } from 'node:path';

const supervisorExtensionPath = resolve(
  import.meta.dirname,
  '../../packages/agent-supervisor-pi/dist/extension.js',
);
const { registerAgentSupervisorExtension } = await import(supervisorExtensionPath);

let currentTelemetry;

export function setActiveBenchmarkTelemetry(telemetry) {
  currentTelemetry = telemetry;
}

export function clearActiveBenchmarkTelemetry() {
  currentTelemetry = undefined;
}

export default function benchmarkSupervisorWrapper(pi) {
  const active = currentTelemetry;
  return registerAgentSupervisorExtension(
    active ? active.wrapExtensionApi(pi) : pi,
  );
}
