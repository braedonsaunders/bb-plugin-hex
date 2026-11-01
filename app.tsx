import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_Icon,
  useSdk,
} from "@get-bb/plugin-sdk/app";

interface VoiceServiceItem {
  id: string;
  displayName: string;
  pluginId: string;
  tasks: string[];
  automaticRank: number | null;
  status:
    | { ready: true }
    | { ready: false; message: string };
}

type VoiceSelection =
  | { mode: "automatic" }
  | { mode: "off" }
  | { mode: "service"; pluginId: string; serviceId: string };

interface AiServicesState {
  selections: {
    voice: VoiceSelection;
    [key: string]: VoiceSelection;
  };
  services: VoiceServiceItem[];
}

const MOUNT_ATTR = "data-bb-voice-provider-picker";

function serviceKey(pluginId: string, serviceId: string): string {
  return `${pluginId}:${serviceId}`;
}

function resolveActiveKey(state: AiServicesState): string | null {
  const selection = state.selections.voice;
  if (!selection) return null;
  if (selection.mode === "service") {
    return serviceKey(selection.pluginId, selection.serviceId);
  }
  if (selection.mode === "automatic") {
    const auto = state.services
      .filter(
        (s) =>
          s.tasks.includes("voice") &&
          s.automaticRank !== null &&
          s.status.ready,
      )
      .sort((a, b) => (a.automaticRank ?? 0) - (b.automaticRank ?? 0))[0];
    return auto ? serviceKey(auto.pluginId, auto.id) : null;
  }
  return null;
}

function findOrCreateMountNode(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const dialog = document.querySelector<HTMLElement>(
    '[aria-label="Voice preferences"]',
  );
  if (!dialog) return null;

  dialog.classList.add("max-h-[82vh]", "overflow-y-auto");

  const stack =
    dialog.querySelector<HTMLElement>(":scope > .space-y-4") ?? dialog;

  let mount = stack.querySelector<HTMLElement>(`[${MOUNT_ATTR}="true"]`);
  if (!mount) {
    mount = document.createElement("div");
    mount.setAttribute(MOUNT_ATTR, "true");
    stack.appendChild(mount);
  }
  return mount;
}

function VoiceProviderSection() {
  const sdk = useSdk();
  const [state, setState] = useState<AiServicesState | null>(null);
  const [optimisticKey, setOptimisticKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = (await sdk.system.aiServices()) as AiServicesState;
      setState(res);
      setOptimisticKey(null);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load voice providers.",
      );
    }
  }, [sdk]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSelect = useCallback(
    async (provider: VoiceServiceItem) => {
      const nextKey = serviceKey(provider.pluginId, provider.id);
      setOptimisticKey(nextKey);
      setSaving(true);
      setError(null);
      try {
        const updated = (await sdk.system.setAiServiceSelection({
          task: "voice",
          selection: {
            mode: "service",
            pluginId: provider.pluginId,
            serviceId: provider.id,
          },
        })) as AiServicesState;
        setState(updated);
        setOptimisticKey(null);
      } catch (err) {
        setOptimisticKey(null);
        setError(
          err instanceof Error
            ? err.message
            : "Could not change voice provider.",
        );
      } finally {
        setSaving(false);
      }
    },
    [sdk],
  );

  if (!state) {
    return (
      <div className="space-y-2">
        <p className="px-1 text-xs font-medium text-muted-foreground">
          Provider
        </p>
        <div className="rounded-lg border px-3 py-2.5 text-xs text-muted-foreground">
          {error ?? "Loading providers…"}
        </div>
      </div>
    );
  }

  const activeKey = optimisticKey ?? resolveActiveKey(state);
  const configuredProviders = state.services.filter(
    (s) =>
      s.tasks.includes("voice") &&
      (s.status.ready || serviceKey(s.pluginId, s.id) === activeKey),
  );

  return (
    <div className="space-y-2">
      <p className="px-1 text-xs font-medium text-muted-foreground">Provider</p>
      <div
        role="group"
        aria-label="Voice provider"
        className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-1"
      >
        {configuredProviders.map((provider) => {
          const key = serviceKey(provider.pluginId, provider.id);
          const isSelected = activeKey === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={isSelected}
              disabled={saving || !provider.status.ready}
              onClick={() => void handleSelect(provider)}
              className={`flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-50 ${
                isSelected ? "bg-state-active" : ""
              }`}
            >
              <experimental_Icon
                name={provider.id === "hex" ? "Mic" : "Sparkles"}
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 break-words">
                {provider.displayName}
              </span>
              <span className="size-4 shrink-0" aria-hidden="true">
                {isSelected ? (
                  <experimental_Icon name="Check" className="size-4" />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="status" className="px-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function VoiceProviderPickerOverlay() {
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const syncMount = () => {
      const next = findOrCreateMountNode();
      setMountNode((prev) => (prev === next ? prev : next));
    };

    syncMount();

    const observer = new MutationObserver(() => {
      syncMount();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      document
        .querySelectorAll(`[${MOUNT_ATTR}="true"]`)
        .forEach((el) => el.remove());
    };
  }, []);

  if (!mountNode) return null;
  return createPortal(<VoiceProviderSection />, mountNode);
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "voice-provider-picker",
    component: VoiceProviderPickerOverlay,
  });
});
