// gRPC client for the vm-manager (the ONLY way we touch containers).
import { createClient, type Client, type Interceptor } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { Priority, VmManager } from '../../../proto-gen/vm/v1/vm_pb.ts';
import { config } from '../../shared/config.ts';
import type { PlanId } from '../auth/users.ts';

export type VmClient = Client<typeof VmManager>;
export {
  AgentRuntime,
  DeliverEventType,
  DeliverKind,
  Priority,
  SandboxState,
} from '../../../proto-gen/vm/v1/vm_pb.ts';

let client: VmClient | undefined;

export function vm(): VmClient {
  if (!client) {
    const secret = config().VM_INTERNAL_SECRET;
    const auth: Interceptor = (next) => (req) => {
      req.header.set('x-internal-secret', secret);
      return next(req);
    };
    client = createClient(
      VmManager,
      createGrpcTransport({ baseUrl: config().VM_MANAGER_URL, interceptors: [auth] }),
    );
  }
  return client;
}

/** Tests: swap in a fake vm-manager. */
export function setVmClient(fake: VmClient | undefined): void {
  client = fake;
}

/** Awake-cap priority by plan (HLD 7.1). */
export function planPriority(plan: PlanId): Priority {
  return plan === 'max' ? Priority.HIGH : plan === 'pro' ? Priority.NORMAL : Priority.LOW;
}
