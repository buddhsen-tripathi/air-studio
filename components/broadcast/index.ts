/**
 * The broadcast design system: the whole visual language of Air Piano Duel in
 * eight presentational components. Nothing in here knows about the chart, the
 * socket or the audio clock — it takes numbers and renders them big.
 */

export { Numeral, SEAT, varColor, useReplayAnimation } from "./Numeral";
export type { NumeralProps, NumeralSize, NumeralTone, Seat } from "./Numeral";

export { Panel } from "./Panel";
export type { PanelProps } from "./Panel";

export { Button } from "./Button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button";

export { NamePlate } from "./NamePlate";
export type { NamePlateProps, NamePlateSize } from "./NamePlate";

export { JudgementBadge } from "./JudgementBadge";
export type { JudgementBadgeProps, JudgementBadgeSize } from "./JudgementBadge";

export { TugOfWar, scoreShare, TUG_STABILISER } from "./TugOfWar";
export type { TugOfWarProps, TugOfWarSize } from "./TugOfWar";

export { StatRow } from "./StatRow";
export type { StatRowProps, StatRowSize } from "./StatRow";

export { Scorebug } from "./Scorebug";
export type { ScorebugProps, ScorebugSide } from "./Scorebug";
