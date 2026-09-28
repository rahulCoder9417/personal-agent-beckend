import { getUser } from '../auth/users.ts';
import { keyModelsForPlan } from './plans.ts';

/** May this user's plan call this LiteLLM model? (Free: the cheap model only; paid: all.) */
export async function canUseModel(userId: string, model: string): Promise<boolean> {
  const user = await getUser(userId);
  if (!user || user.deletedAt) return false;
  return keyModelsForPlan(user.plan).includes(model);
}
