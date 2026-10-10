import { cn } from "@/lib/utils";

/**
 * The outcome of a form action, announced to screen readers. An error wins over
 * progress, and progress over a confirmation.
 */
function FormStatus({
  error,
  pending,
  notice,
  className,
}: {
  error?: string;
  pending?: string;
  notice?: string;
  className?: string;
}) {
  const message = error || pending || notice;
  return (
    // Hidden while empty so it adds no gap; the messages inside carry their own live roles.
    <div data-slot="form-status" aria-live="polite" className={cn("empty:hidden", className)}>
      {error ? (
        <p role="alert" className="m-0 text-xs text-destructive">
          {error}
        </p>
      ) : message ? (
        <p role="status" className="m-0 text-xs text-dim">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export { FormStatus };
