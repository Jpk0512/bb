import { PluginSlotMount } from "./PluginSlotMount";
import { usePluginSlots } from "@/lib/plugin-slots";

/**
 * Plugin `transcriptPrelude` slots: components rendered above the native
 * thread timeline so a prior session (for example after a provider switch)
 * can appear inside the chat pane.
 */
export function PluginTranscriptPreludes({ threadId }: { threadId: string }) {
  const { transcriptPreludes } = usePluginSlots();
  if (transcriptPreludes.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 px-3 pt-3">
      {transcriptPreludes.map((slot) => {
        const Component = slot.component;
        return (
          <PluginSlotMount
            key={`${slot.pluginId}/${slot.id}/${slot.generation}/${threadId}`}
            pluginId={slot.pluginId}
            slotKind="transcriptPrelude"
            slotId={slot.id}
            instanceId={threadId}
            crashFallback={null}
          >
            <Component threadId={threadId} />
          </PluginSlotMount>
        );
      })}
    </div>
  );
}
