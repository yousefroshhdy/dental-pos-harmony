import { getUserContext } from "@/lib/authz/context";
import { CompleteTaskFormClient } from "./complete-task-form-client";

/**
 * Server wrapper: the offline queue is per user, so the client form needs the
 * signed-in user's id (getUserContext is cached per request, so a list of
 * tasks reads it once).
 */
export async function CompleteTaskForm({ taskId, title }: { taskId: string; title: string }) {
  const ctx = await getUserContext();
  if (!ctx.user_id) return null;
  return <CompleteTaskFormClient taskId={taskId} title={title} userId={ctx.user_id} />;
}
