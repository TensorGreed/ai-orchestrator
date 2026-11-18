import { createContext } from "react";

/** What a node card needs to draw the `+` on its outputs: which outputs are connected, and what clicking `+` does. */
export interface CanvasInsertActions {
  /** Opens the palette; the node picked is connected after this output (`null` = the main output). */
  onAddAfter: (nodeId: string, handle: string | null) => void;
  /** Whether this output already has an outgoing edge. */
  isConnected: (nodeId: string, handle: string | null) => boolean;
}

/** Null outside the editor canvas (previews, tests): no `+` is drawn. */
export const CanvasInsertContext = createContext<CanvasInsertActions | null>(null);
