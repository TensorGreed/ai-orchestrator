import { StudioHud, type StudioHudProps } from "./StudioHud";

export type TopBarProps = StudioHudProps;

/** Legacy name for the HUD; prefer `StudioHud` in new code. */
export function TopBar(props: TopBarProps) {
  return <StudioHud {...props} />;
}
