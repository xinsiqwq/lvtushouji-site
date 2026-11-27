import type { SecurityPolicy } from '../shared/types';

export type AppBindings = Env & {
  ARENA_ROOM: DurableObjectNamespace;
  SESSION_SECRET: string;
  SETUP_TOKEN?: string;
  TIANDITU_KEY?: string;
};

export type CloudContext = {
  configured: boolean;
  authenticated: boolean;
  sessionId: string | null;
  csrfToken: string | null;
  visitorId: string;
  address: string;
  policy: SecurityPolicy;
  cookies: string[];
};

export type AppVariables = {
  costEnv: AppBindings;
  cloudCtx: CloudContext;
};
