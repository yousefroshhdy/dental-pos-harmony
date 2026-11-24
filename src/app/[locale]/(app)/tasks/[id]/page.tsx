import { redirect } from "next/navigation";

/**
 * Task notifications link to /tasks/<id> (api.create_task, migration 20261029000200). There is no
 * task detail screen: the task list is where tasks are read and completed, and it applies the
 * caller's own scope, so this only forwards there. Keeps every stored notification link working.
 */
export default async function TaskLinkPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale } = await params;
  redirect(`/${locale}/tasks`);
}
