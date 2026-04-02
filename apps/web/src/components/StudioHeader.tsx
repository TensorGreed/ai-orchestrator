import type { ComponentProps } from "react";
import { TopBar } from "./TopBar";

type StudioHeaderProps = ComponentProps<typeof TopBar>;

export function StudioHeader(props: StudioHeaderProps) {
  return <TopBar {...props} />;
}
