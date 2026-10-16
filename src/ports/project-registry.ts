import type { OperationResult } from '../contracts/operation-result.js';
import type {
  ProjectList,
  ProjectListRequest,
  ProjectRegistration,
  RegisteredProject,
  RegistryCheckout,
  RunBinding,
} from '../contracts/projects.js';
import type { StateRepository, StateWriteResult } from '../contracts/state.js';

export interface ProjectRegistry {
  readProject(id: string): Promise<OperationResult<RegisteredProject | null>>;
  readCheckout(id: string): Promise<OperationResult<RegistryCheckout | null>>;
  findCheckout(rootPath: string): Promise<OperationResult<RegistryCheckout | null>>;
  findRepository(commonDirectory: string): Promise<OperationResult<StateRepository | null>>;
  findRegisteredProject(repositoryId: string): Promise<OperationResult<RegisteredProject | null>>;
  readRun(id: string): Promise<OperationResult<RunBinding | null>>;
  register(registration: ProjectRegistration): StateWriteResult<ProjectRegistration>;
  list(request: ProjectListRequest): Promise<OperationResult<ProjectList>>;
}
