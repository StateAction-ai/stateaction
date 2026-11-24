import Link from "next/link";

export default function NotFound() {
  return (
    <section
      aria-labelledby="unavailable-heading"
      className="mx-auto max-w-lg px-6 py-16"
    >
      <h1 id="unavailable-heading" className="mb-2 text-2xl font-bold">
        Page unavailable
      </h1>
      <p className="mb-4 text-muted">
        The page may have moved or may be unavailable to your account.
      </p>
      <Link href="/" className="font-semibold text-brand underline">
        Return to the homepage
      </Link>
    </section>
  );
}
