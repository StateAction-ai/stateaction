"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "../ui/button";

export function ConfirmDialog({
  title,
  busy,
  close,
  children,
}: {
  title: string;
  busy: boolean;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      className="m-auto max-h-[90vh] w-[min(92vw,40rem)] overflow-y-auto rounded-xl border border-line bg-paper p-5 text-ink shadow-xl backdrop:bg-black/40 sm:p-6"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">{title}</h2>
        <Button variant="ghost" disabled={busy} onClick={close}>
          Close
        </Button>
      </div>
      {children}
    </dialog>
  );
}
