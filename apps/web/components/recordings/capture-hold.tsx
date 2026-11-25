"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { recipeHref } from "../../lib/recipe-view";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { postRecordingCommand } from "./commands";
import { ConfirmDialog } from "./confirm-dialog";

export function CaptureHold({
  recordingId,
  sourceManifestSha256,
  reason,
  description,
  report,
  allowedRecipeIds,
  defaultRecipeId,
  readOnly,
}: {
  recordingId: string;
  sourceManifestSha256: string;
  reason: "needs_setup" | "choose_recipe";
  description: string;
  report: string;
  allowedRecipeIds: readonly string[];
  defaultRecipeId?: string | null;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [recipeId, setRecipeId] = useState(
    defaultRecipeId && allowedRecipeIds.includes(defaultRecipeId)
      ? defaultRecipeId
      : (allowedRecipeIds[0] ?? ""),
  );

  async function choose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !allowedRecipeIds.includes(recipeId)) return;
    setBusy(true);
    setError("");
    try {
      await postRecordingCommand(
        `/api/v1/recordings/${recordingId}/capture-recipe`,
        {
          recipeId,
          sourceManifestSha256,
        },
      );
      setOpen(false);
      setMessage("Recipe selected.");
      router.refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report);
      setMessage("Device report copied.");
    } catch {
      setMessage("Could not copy the device report.");
    }
  }

  return (
    <Card className="grid justify-items-start gap-2 p-4 text-sm">
      <h2 className="text-base font-bold">
        {reason === "needs_setup" ? "Needs setup" : "Choose a recipe"}
      </h2>
      <p>{description}</p>
      {reason === "needs_setup" ? (
        <>
          <p className="text-muted">
            Send the device report to an engineer to configure this capture
            source.
          </p>
          <Button variant="outline" onClick={() => void copyReport()}>
            Copy device report
          </Button>
        </>
      ) : (
        <Button
          disabled={readOnly || !allowedRecipeIds.length || Boolean(message)}
          onClick={() => {
            setError("");
            setOpen(true);
          }}
        >
          Choose a recipe
        </Button>
      )}
      {readOnly && reason === "choose_recipe" && (
        <p className="text-muted">This environment is read-only.</p>
      )}
      {message && (
        <p role="status" className="text-muted">
          {message}
        </p>
      )}
      {open && (
        <ConfirmDialog
          title="Choose a recipe"
          busy={busy}
          close={() => setOpen(false)}
        >
          <form onSubmit={(event) => void choose(event)} className="grid gap-3">
            <label className="grid gap-1">
              <span className="font-semibold">Processing recipe</span>
              <select
                value={recipeId}
                onChange={(event) => setRecipeId(event.currentTarget.value)}
                className="rounded-lg border border-line bg-field p-2"
                disabled={busy}
              >
                {allowedRecipeIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                    {id === defaultRecipeId ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {recipeId && (
              <Link
                href={recipeHref(recipeId)}
                className="text-brand underline"
              >
                View recipe
              </Link>
            )}
            <p className="text-muted">
              Processing will use this recipe and the sealed upload.
            </p>
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy || !recipeId}>
              {busy ? "Selecting…" : "Start processing"}
            </Button>
          </form>
        </ConfirmDialog>
      )}
    </Card>
  );
}
