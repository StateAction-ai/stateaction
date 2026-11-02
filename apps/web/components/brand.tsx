import Link from "next/link";

export function BrandMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 -rotate-[8deg] grid-cols-2 gap-[3px] ${className}`}
    >
      <span className="rounded-[3px] bg-ink" />
      <span className="rounded-[3px] bg-ink" />
      <span className="rounded-[3px] bg-ink" />
      <span className="rounded-[3px] bg-[#5278de]" />
    </span>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2.5 rounded-md text-[19px] font-bold tracking-[-0.04em] text-brand"
    >
      <BrandMark />
      <span className="whitespace-nowrap">StateAction.ai</span>
    </Link>
  );
}
