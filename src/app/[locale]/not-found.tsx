import { Link } from "@/i18n/navigation";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-5xl font-bold">404</p>
      <Link href="/" className="text-primary underline-offset-4 hover:underline">
        Honest OS
      </Link>
    </main>
  );
}
