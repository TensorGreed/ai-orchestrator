import { StudioHud, type StudioHudProps } from "./StudioHud";

export type StudioHeaderProps = StudioHudProps;

/** The floating HUD row. Kept under the legacy export name so App.tsx wiring stays unchanged. */
export function StudioHeader(props: StudioHeaderProps) {
  return <StudioHud {...props} />;
}
