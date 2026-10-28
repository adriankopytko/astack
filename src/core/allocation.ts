import type { AllocationRequest, AllocatedValue } from '../contracts/resources.js';
import { configurationDigest } from './configuration.js';
export function allocationId(request: AllocationRequest) {
  return `allocation-${configurationDigest({ attemptId: request.attemptId, key: request.key })}`;
}

export function allocationValue(
  request: AllocationRequest,
  id: string,
  index: number,
): AllocatedValue {
  const spec = request.spec;

  return spec.kind === 'port'
    ? { kind: 'port', protocol: spec.protocol, host: spec.host, port: spec.candidates[index]! }
    : {
        kind: 'name',
        namespace: spec.namespace,
        name: spec.fixed ? spec.prefix : `${spec.prefix.slice(0, 30)}-${id.slice(-32)}`,
      };
}

export function allocationKey(value: AllocatedValue) {
  return value.kind === 'port'
    ? `port:${value.protocol}:${value.port}`
    : `name:${value.namespace}:${value.name}`;
}
