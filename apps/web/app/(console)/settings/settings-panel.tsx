"use client";
import { SettingsForm } from "../../../components/settings-form";
import { useRefresh } from "../../../components/console-client";
import { saveDisplayName } from "../../../lib/client-api";

export function SettingsPanel() {
  const refresh = useRefresh();
  return <SettingsForm save={saveDisplayName} onSaved={refresh} />;
}
