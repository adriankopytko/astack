import {
  applicationInfoRequestSchema,
  applicationInfoSchema,
  type ApplicationInfo,
} from '../contracts/application-info.js';
import { completed, type OperationResult } from '../contracts/operation-result.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';

/** Describe the package without probing projects, providers, or user state. */
export function getApplicationInfo(
  input: unknown,
  version: string,
): OperationResult<ApplicationInfo> {
  const request = parseOperationRequest(applicationInfoRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  return completed(applicationInfoSchema.parse({ name: 'astack', version, stage: 'foundation' }));
}
